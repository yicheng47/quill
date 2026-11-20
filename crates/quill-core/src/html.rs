/// Convert an HTML fragment (such as an EPUB `<dc:description>`) into clean,
/// single-line plain text suitable for library cards and metadata APIs.
/// Returns `None` when the cleaned text is empty.
pub(crate) fn clean_description(raw: &str) -> Option<String> {
    let text = html_to_plain_text(raw);
    (!text.is_empty()).then_some(text)
}

pub(crate) fn html_to_plain_text(input: &str) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut i = 0;

    while i < len {
        match bytes[i] {
            b'<' => {
                if let Some(next_i) = try_consume_markup(input, i, &mut out) {
                    i = next_i;
                } else {
                    out.push('<');
                    i += 1;
                }
            }
            b'&' => {
                if let Some((decoded, next_i)) = try_decode_entity(input, i) {
                    if let DecodedEntity::Char(ch) = decoded {
                        out.push(ch);
                    }
                    i = next_i;
                } else {
                    out.push('&');
                    i += 1;
                }
            }
            _ => {
                let start = i;
                i += 1;
                while i < len && bytes[i] != b'<' && bytes[i] != b'&' {
                    i += 1;
                }
                out.push_str(&input[start..i]);
            }
        }
    }

    collapse_whitespace(&out)
}

fn collapse_whitespace(s: &str) -> String {
    let mut collapsed = String::with_capacity(s.len());
    for word in s.split_whitespace() {
        if !collapsed.is_empty() {
            collapsed.push(' ');
        }
        collapsed.push_str(word);
    }
    collapsed
}

/// Try to consume an HTML comment, declaration, processing instruction, CDATA
/// section, or known HTML tag starting at byte offset `start` (which points to `<`).
fn try_consume_markup(input: &str, start: usize, out: &mut String) -> Option<usize> {
    let bytes = input.as_bytes();
    let rest = &input[start..];

    // HTML comment: <!-- ... -->
    if rest.starts_with("<!--") {
        let after = &input[start + 4..];
        if after.starts_with('>') {
            return Some(start + 5);
        }
        if after.starts_with("->") {
            return Some(start + 6);
        }
        return match after.find("-->") {
            Some(pos) => Some(start + 4 + pos + 3),
            None => Some(bytes.len()),
        };
    }

    // CDATA section: <![CDATA[ ... ]]>
    if bytes
        .get(start..start + 9)
        .is_some_and(|s| s.eq_ignore_ascii_case(b"<![CDATA["))
    {
        if let Some(pos) = input[start + 9..].find("]]>") {
            out.push_str(&input[start + 9..start + 9 + pos]);
            return Some(start + 9 + pos + 3);
        }
        return None;
    }

    // Declaration: <!DOCTYPE ...>
    if rest.starts_with("<!") && bytes.get(start + 2).is_some_and(u8::is_ascii_alphabetic) {
        let gt = find_tag_close(bytes, start + 2)?;
        return Some(gt + 1);
    }

    // Processing instruction: <?xml ... ?>
    if rest.starts_with("<?") {
        let pos = input[start + 2..].find("?>")?;
        return Some(start + 2 + pos + 2);
    }

    // Start or end tag: <tag ...>, <tag/>, </tag>
    let is_closing = bytes.get(start + 1) == Some(&b'/');
    let name_start = if is_closing { start + 2 } else { start + 1 };
    if !bytes.get(name_start).is_some_and(u8::is_ascii_alphabetic) {
        return None;
    }

    let mut name_end = name_start + 1;
    while name_end < bytes.len()
        && (bytes[name_end].is_ascii_alphanumeric()
            || matches!(bytes[name_end], b'-' | b':' | b'_'))
    {
        name_end += 1;
    }

    let tag_name = &input[name_start..name_end];
    if !is_html_tag(tag_name) {
        return None;
    }

    let (tag_end, self_closing) = if is_closing {
        let mut j = name_end;
        while j < bytes.len() && bytes[j].is_ascii_whitespace() {
            j += 1;
        }
        if bytes.get(j) != Some(&b'>') {
            return None;
        }
        (j + 1, false)
    } else {
        match bytes.get(name_end) {
            Some(&b'>') => (name_end + 1, false),
            Some(&b'/') => {
                if bytes.get(name_end + 1) != Some(&b'>') {
                    return None;
                }
                (name_end + 2, true)
            }
            Some(b) if b.is_ascii_whitespace() => {
                let gt = find_tag_close(bytes, name_end + 1)?;
                let mut prev = gt;
                while prev > name_end && bytes[prev - 1].is_ascii_whitespace() {
                    prev -= 1;
                }
                let self_closing = prev > name_end && bytes[prev - 1] == b'/';
                (gt + 1, self_closing)
            }
            _ => return None,
        }
    };

    let local_name = tag_name.rsplit(':').next().unwrap_or(tag_name);

    // Drop entire contents of non-content elements like <style>, <script>, and <title>.
    // `<head>` itself is stripped as an ordinary tag so an omitted `</head>` end tag
    // never swallows following `<body>` content.
    if !is_closing && !self_closing && is_ignored_container(local_name) {
        out.push(' ');
        return Some(skip_until_closing_tag(input, tag_end, tag_name));
    }

    if is_block_or_break_tag(local_name) {
        out.push(' ');
    }

    Some(tag_end)
}

/// Find the byte index of the closing `>` of an opening tag or declaration,
/// ignoring `>` inside quoted attribute values.
fn find_tag_close(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    let mut in_quote: Option<u8> = None;
    let mut after_eq = false;

    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = in_quote {
            if b == q {
                in_quote = None;
            }
        } else {
            match b {
                b'>' => return Some(i),
                b'=' => after_eq = true,
                b'"' | b'\'' if after_eq => {
                    in_quote = Some(b);
                    after_eq = false;
                }
                b if !b.is_ascii_whitespace() => after_eq = false,
                _ => {}
            }
        }
        i += 1;
    }

    None
}

/// Advance past the matching `</tag_name>` closing tag (or to EOF if unclosed).
fn skip_until_closing_tag(input: &str, start: usize, tag_name: &str) -> usize {
    let bytes = input.as_bytes();
    let tag_len = tag_name.len();
    let mut i = start;

    while i + 2 + tag_len < bytes.len() {
        if bytes[i] == b'<'
            && bytes[i + 1] == b'/'
            && bytes[i + 2..i + 2 + tag_len].eq_ignore_ascii_case(tag_name.as_bytes())
        {
            let mut j = i + 2 + tag_len;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if bytes.get(j) == Some(&b'>') {
                return j + 1;
            }
        }
        i += 1;
    }

    bytes.len()
}

fn is_html_tag(tag_name: &str) -> bool {
    if let Some((prefix, local)) = tag_name.split_once(':') {
        if local.is_empty() || local.contains(':') {
            return false;
        }
        let known_prefix = matches!(
            ascii_lower_stack(prefix).as_deref(),
            Some("o" | "w" | "v" | "st1" | "mbp" | "calibre" | "xhtml" | "epub" | "svg")
        );
        return known_prefix
            && local
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    }

    matches!(
        ascii_lower_stack(tag_name).as_deref(),
        Some(
            "a" | "abbr"
                | "acronym"
                | "address"
                | "area"
                | "article"
                | "aside"
                | "audio"
                | "b"
                | "base"
                | "bdi"
                | "bdo"
                | "big"
                | "blink"
                | "blockquote"
                | "body"
                | "br"
                | "button"
                | "canvas"
                | "caption"
                | "center"
                | "cite"
                | "code"
                | "col"
                | "colgroup"
                | "data"
                | "datalist"
                | "dd"
                | "del"
                | "details"
                | "dfn"
                | "dialog"
                | "div"
                | "dl"
                | "dt"
                | "em"
                | "embed"
                | "fieldset"
                | "figcaption"
                | "figure"
                | "font"
                | "footer"
                | "form"
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6"
                | "head"
                | "header"
                | "hgroup"
                | "hr"
                | "html"
                | "i"
                | "iframe"
                | "img"
                | "input"
                | "ins"
                | "kbd"
                | "label"
                | "legend"
                | "li"
                | "link"
                | "main"
                | "map"
                | "mark"
                | "marquee"
                | "math"
                | "menu"
                | "meta"
                | "meter"
                | "nav"
                | "nobr"
                | "noscript"
                | "object"
                | "ol"
                | "optgroup"
                | "option"
                | "output"
                | "p"
                | "param"
                | "picture"
                | "pre"
                | "progress"
                | "q"
                | "rp"
                | "rt"
                | "ruby"
                | "s"
                | "samp"
                | "script"
                | "section"
                | "select"
                | "slot"
                | "small"
                | "source"
                | "span"
                | "strike"
                | "strong"
                | "style"
                | "sub"
                | "summary"
                | "sup"
                | "svg"
                | "table"
                | "tbody"
                | "td"
                | "template"
                | "textarea"
                | "tfoot"
                | "th"
                | "thead"
                | "time"
                | "title"
                | "tr"
                | "track"
                | "tt"
                | "u"
                | "ul"
                | "var"
                | "video"
                | "wbr"
        )
    )
}

fn is_ignored_container(local_name: &str) -> bool {
    matches!(
        ascii_lower_stack(local_name).as_deref(),
        Some("style" | "script" | "title")
    )
}

fn is_block_or_break_tag(local_name: &str) -> bool {
    matches!(
        ascii_lower_stack(local_name).as_deref(),
        Some(
            "address"
                | "article"
                | "aside"
                | "blockquote"
                | "body"
                | "br"
                | "caption"
                | "center"
                | "dd"
                | "details"
                | "div"
                | "dl"
                | "dt"
                | "figcaption"
                | "figure"
                | "footer"
                | "h1"
                | "h2"
                | "h3"
                | "h4"
                | "h5"
                | "h6"
                | "header"
                | "hgroup"
                | "hr"
                | "li"
                | "main"
                | "nav"
                | "ol"
                | "p"
                | "pagebreak"
                | "pre"
                | "section"
                | "summary"
                | "table"
                | "tbody"
                | "td"
                | "tfoot"
                | "th"
                | "thead"
                | "tr"
                | "ul"
        )
    )
}

struct StackLower {
    buf: [u8; 16],
    len: usize,
}

impl std::ops::Deref for StackLower {
    type Target = str;
    fn deref(&self) -> &str {
        // SAFETY: only ASCII bytes are written into `buf`.
        std::str::from_utf8(&self.buf[..self.len]).unwrap_or("")
    }
}

fn ascii_lower_stack(s: &str) -> Option<StackLower> {
    if s.len() > 16 || !s.is_ascii() {
        return None;
    }
    let mut buf = [0u8; 16];
    for (dst, src) in buf.iter_mut().zip(s.bytes()) {
        *dst = src.to_ascii_lowercase();
    }
    Some(StackLower { buf, len: s.len() })
}

enum DecodedEntity {
    Char(char),
    Empty,
}

fn try_decode_entity(input: &str, start: usize) -> Option<(DecodedEntity, usize)> {
    let bytes = input.as_bytes();
    let max_end = (start + 32).min(bytes.len());
    let mut semi = None;

    for (idx, &b) in bytes.iter().enumerate().take(max_end).skip(start + 1) {
        if b == b';' {
            semi = Some(idx);
            break;
        }
        if b.is_ascii_whitespace() || matches!(b, b'<' | b'>' | b'&') {
            return None;
        }
    }

    let semi = semi?;
    let entity = &input[start + 1..semi];
    if entity.is_empty() {
        return None;
    }

    let decoded = if let Some(num) = entity.strip_prefix('#') {
        decode_numeric_entity(num)?
    } else {
        decode_named_entity(entity)?
    };

    Some((decoded, semi + 1))
}

fn decode_numeric_entity(num: &str) -> Option<DecodedEntity> {
    let cp = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
        if hex.is_empty() || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        u32::from_str_radix(hex, 16).ok()?
    } else {
        if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        num.parse::<u32>().ok()?
    };

    if cp == 0 {
        return None;
    }
    if cp == 0xAD {
        return Some(DecodedEntity::Empty);
    }
    if (0x80..=0x9F).contains(&cp) {
        return windows_1252_c1(cp).map(DecodedEntity::Char);
    }
    char::from_u32(cp).map(DecodedEntity::Char)
}

/// WHATWG HTML5 replacement mapping for numeric references in the C1 control
/// range (0x80..=0x9F), commonly emitted by Windows-1252 book toolchains.
fn windows_1252_c1(cp: u32) -> Option<char> {
    match cp {
        0x80 => Some('\u{20AC}'),
        0x82 => Some('\u{201A}'),
        0x83 => Some('\u{0192}'),
        0x84 => Some('\u{201E}'),
        0x85 => Some('\u{2026}'),
        0x86 => Some('\u{2020}'),
        0x87 => Some('\u{2021}'),
        0x88 => Some('\u{02C6}'),
        0x89 => Some('\u{2030}'),
        0x8A => Some('\u{0160}'),
        0x8B => Some('\u{2039}'),
        0x8C => Some('\u{0152}'),
        0x8E => Some('\u{017D}'),
        0x91 => Some('\u{2018}'),
        0x92 => Some('\u{2019}'),
        0x93 => Some('\u{201C}'),
        0x94 => Some('\u{201D}'),
        0x95 => Some('\u{2022}'),
        0x96 => Some('\u{2013}'),
        0x97 => Some('\u{2014}'),
        0x98 => Some('\u{02DC}'),
        0x99 => Some('\u{2122}'),
        0x9A => Some('\u{0161}'),
        0x9B => Some('\u{203A}'),
        0x9C => Some('\u{0153}'),
        0x9E => Some('\u{017E}'),
        0x9F => Some('\u{0178}'),
        _ => None,
    }
}

fn decode_named_entity(name: &str) -> Option<DecodedEntity> {
    if name == "shy" {
        return Some(DecodedEntity::Empty);
    }
    let ch = match name {
        // Core XML / HTML
        "amp" | "AMP" => '&',
        "lt" | "LT" => '<',
        "gt" | "GT" => '>',
        "quot" | "QUOT" => '"',
        "apos" => '\'',
        // Spaces
        "nbsp" => '\u{00A0}',
        "ensp" => '\u{2002}',
        "emsp" => '\u{2003}',
        "thinsp" => '\u{2009}',
        // Typography & punctuation
        "mdash" => '\u{2014}',
        "ndash" => '\u{2013}',
        "lsquo" => '\u{2018}',
        "rsquo" => '\u{2019}',
        "sbquo" => '\u{201A}',
        "ldquo" => '\u{201C}',
        "rdquo" => '\u{201D}',
        "bdquo" => '\u{201E}',
        "hellip" => '\u{2026}',
        "bull" => '\u{2022}',
        "middot" => '\u{00B7}',
        "laquo" => '\u{00AB}',
        "raquo" => '\u{00BB}',
        "lsaquo" => '\u{2039}',
        "rsaquo" => '\u{203A}',
        "prime" => '\u{2032}',
        "Prime" => '\u{2033}',
        "dagger" => '\u{2020}',
        "Dagger" => '\u{2021}',
        "permil" => '\u{2030}',
        "iexcl" => '\u{00A1}',
        "iquest" => '\u{00BF}',
        "sect" => '\u{00A7}',
        "para" => '\u{00B6}',
        "deg" => '\u{00B0}',
        "plusmn" => '\u{00B1}',
        "times" => '\u{00D7}',
        "divide" => '\u{00F7}',
        "minus" => '\u{2212}',
        "frac14" => '\u{00BC}',
        "frac12" => '\u{00BD}',
        "frac34" => '\u{00BE}',
        "sup1" => '\u{00B9}',
        "sup2" => '\u{00B2}',
        "sup3" => '\u{00B3}',
        "ordf" => '\u{00AA}',
        "ordm" => '\u{00BA}',
        "not" => '\u{00AC}',
        "macr" => '\u{00AF}',
        "acute" => '\u{00B4}',
        "cedil" => '\u{00B8}',
        "uml" => '\u{00A8}',
        "brvbar" => '\u{00A6}',
        // Legal & currency
        "copy" | "COPY" => '\u{00A9}',
        "reg" | "REG" => '\u{00AE}',
        "trade" | "TRADE" => '\u{2122}',
        "euro" => '\u{20AC}',
        "pound" => '\u{00A3}',
        "yen" => '\u{00A5}',
        "cent" => '\u{00A2}',
        "curren" => '\u{00A4}',
        // Common arrows & math
        "larr" => '\u{2190}',
        "uarr" => '\u{2191}',
        "rarr" => '\u{2192}',
        "darr" => '\u{2193}',
        "harr" => '\u{2194}',
        "le" => '\u{2264}',
        "ge" => '\u{2265}',
        "ne" => '\u{2260}',
        "infin" => '\u{221E}',
        // ISO-8859-1 / Latin extended letters
        "Agrave" => '\u{00C0}',
        "Aacute" => '\u{00C1}',
        "Acirc" => '\u{00C2}',
        "Atilde" => '\u{00C3}',
        "Auml" => '\u{00C4}',
        "Aring" => '\u{00C5}',
        "AElig" => '\u{00C6}',
        "Ccedil" => '\u{00C7}',
        "Egrave" => '\u{00C8}',
        "Eacute" => '\u{00C9}',
        "Ecirc" => '\u{00CA}',
        "Euml" => '\u{00CB}',
        "Igrave" => '\u{00CC}',
        "Iacute" => '\u{00CD}',
        "Icirc" => '\u{00CE}',
        "Iuml" => '\u{00CF}',
        "ETH" => '\u{00D0}',
        "Ntilde" => '\u{00D1}',
        "Ograve" => '\u{00D2}',
        "Oacute" => '\u{00D3}',
        "Ocirc" => '\u{00D4}',
        "Otilde" => '\u{00D5}',
        "Ouml" => '\u{00D6}',
        "Oslash" => '\u{00D8}',
        "Ugrave" => '\u{00D9}',
        "Uacute" => '\u{00DA}',
        "Ucirc" => '\u{00DB}',
        "Uuml" => '\u{00DC}',
        "Yacute" => '\u{00DD}',
        "THORN" => '\u{00DE}',
        "szlig" => '\u{00DF}',
        "agrave" => '\u{00E0}',
        "aacute" => '\u{00E1}',
        "acirc" => '\u{00E2}',
        "atilde" => '\u{00E3}',
        "auml" => '\u{00E4}',
        "aring" => '\u{00E5}',
        "aelig" => '\u{00E6}',
        "ccedil" => '\u{00E7}',
        "egrave" => '\u{00E8}',
        "eacute" => '\u{00E9}',
        "ecirc" => '\u{00EA}',
        "euml" => '\u{00EB}',
        "igrave" => '\u{00EC}',
        "iacute" => '\u{00ED}',
        "icirc" => '\u{00EE}',
        "iuml" => '\u{00EF}',
        "eth" => '\u{00F0}',
        "ntilde" => '\u{00F1}',
        "ograve" => '\u{00F2}',
        "oacute" => '\u{00F3}',
        "ocirc" => '\u{00F4}',
        "otilde" => '\u{00F5}',
        "ouml" => '\u{00F6}',
        "oslash" => '\u{00F8}',
        "ugrave" => '\u{00F9}',
        "uacute" => '\u{00FA}',
        "ucirc" => '\u{00FB}',
        "uuml" => '\u{00FC}',
        "yacute" => '\u{00FD}',
        "thorn" => '\u{00FE}',
        "yuml" => '\u{00FF}',
        "OElig" => '\u{0152}',
        "oelig" => '\u{0153}',
        "Scaron" => '\u{0160}',
        "scaron" => '\u{0161}',
        "Yuml" => '\u{0178}',
        _ => return None,
    };
    Some(DecodedEntity::Char(ch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_amazon_calibre_html_blurb() {
        let raw = r#"<div> <p style="font-family: 'Amazon Ember','Arial','sans-serif'; font-size: 14px"><strong style="color: #0f1111; background-color: #ffffff">Introducing Geralt the Witcher - revered and hated - who holds the line against the monsters plaguing humanity.</strong></p></div>"#;
        assert_eq!(
            clean_description(raw).as_deref(),
            Some(
                "Introducing Geralt the Witcher - revered and hated - who holds the line against the monsters plaguing humanity."
            )
        );
    }

    #[test]
    fn separates_block_elements_but_keeps_inline_words_joined() {
        let raw = "<p><b>H</b>ello <em>un</em>real world.</p><p>Second paragraph.<br/>Third line.</p><ul><li>One</li><li>Two</li></ul>";
        assert_eq!(
            clean_description(raw).as_deref(),
            Some("Hello unreal world. Second paragraph. Third line. One Two")
        );
    }

    #[test]
    fn decodes_named_numeric_and_win1252_entities() {
        let raw = "<p>Geralt&rsquo;s world &mdash; &ldquo;magic&rdquo; &amp; monsters&nbsp;&#8212;&#x2019;&#151;&#133; caf&eacute; soft&shy;wrap</p>";
        assert_eq!(
            clean_description(raw).as_deref(),
            Some("Geralt\u{2019}s world \u{2014} \u{201C}magic\u{201D} & monsters \u{2014}\u{2019}\u{2014}\u{2026} caf\u{00E9} softwrap")
        );
    }

    #[test]
    fn handles_quotes_and_gt_inside_attributes() {
        let raw = r#"<div title="a > b" data-note='c > d'>Clean text</div>"#;
        assert_eq!(clean_description(raw).as_deref(), Some("Clean text"));
    }

    #[test]
    fn drops_comments_styles_scripts_and_head() {
        let raw = "<!DOCTYPE html><html><head><title>Ignored</title><style>p { color: red; }</style></head><body><!--StartFragment--><script>alert(1)</script><p>Real summary.</p><!--EndFragment--></body></html>";
        assert_eq!(clean_description(raw).as_deref(), Some("Real summary."));
    }

    #[test]
    fn keeps_body_when_head_end_tag_is_omitted() {
        assert_eq!(
            clean_description(
                "<html><head><title>Book</title><body><p>Actual summary.</p></body></html>"
            )
            .as_deref(),
            Some("Actual summary.")
        );
        assert_eq!(
            clean_description(
                r#"<html><head><meta charset="utf-8"><style>p { color: red; }</style><p>Direct paragraph.</p></html>"#
            )
            .as_deref(),
            Some("Direct paragraph.")
        );
        assert_eq!(
            clean_description("<html><title>Book</title><p>No head tags.</p></html>").as_deref(),
            Some("No head tags.")
        );
    }

    #[test]
    fn preserves_plain_text_angle_brackets_urls_emails_and_ampersands() {
        let raw = "R&D notes: x < 5 and y > 3, std::vector<int>, <https://example.com>, <author@example.com>, <3 books & unknown &foo; entity";
        assert_eq!(clean_description(raw).as_deref(), Some(raw));
    }

    #[test]
    fn preserves_unclosed_tag_text_and_handles_office_namespaced_tags() {
        assert_eq!(
            clean_description("A story <p without closing").as_deref(),
            Some("A story <p without closing")
        );
        assert_eq!(
            clean_description("<o:p>First</o:p><mbp:pagebreak/>Second").as_deref(),
            Some("First Second")
        );
    }

    #[test]
    fn returns_none_for_empty_or_markup_only_descriptions() {
        assert_eq!(clean_description(""), None);
        assert_eq!(clean_description("   \n\t  "), None);
        assert_eq!(clean_description("<div><p>&nbsp;<br/></p><!-- empty --></div>"), None);
    }

    #[test]
    fn preserves_utf8_cjk_and_collapses_newlines() {
        let raw = "<p>这是一本\n  关于<strong>阅读</strong>的书。</p>\n<p>第二段。</p>";
        assert_eq!(
            clean_description(raw).as_deref(),
            Some("这是一本 关于阅读的书。 第二段。")
        );
    }

    #[test]
    fn handles_multibyte_utf8_near_markup_delimiters_without_panicking() {
        assert_eq!(
            clean_description("<![CDAT中文测试").as_deref(),
            Some("<![CDAT中文测试")
        );
        assert_eq!(
            clean_description("<style>/* </中文> */</style><p>正文</p>").as_deref(),
            Some("正文")
        );
    }
}
