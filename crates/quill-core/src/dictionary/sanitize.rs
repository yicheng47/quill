//! Strict HTML sanitizer and markup normalizer for user-imported dictionaries
//! (StarDict HTML / Pango / XDXF and MDict HTML).
//!
//! Only safe structural tags are retained, all attributes (inline styles,
//! event handlers, colors, backgrounds, hrefs) are stripped so imported entries
//! inherit Quill's Dawn light and Ember dark typography and colors cleanly.

const ALLOWED_TAGS: &[&str] = &[
    "p", "div", "span", "b", "strong", "i", "em", "u", "br", "ul", "ol", "li", "dl", "dt", "dd",
    "sub", "sup", "small", "hr", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "table",
    "thead", "tbody", "tr", "th", "td",
];

const VOID_TAGS: &[&str] = &["br", "hr"];

const DROP_CONTAINER_TAGS: &[&str] = &[
    "script", "style", "iframe", "object", "embed", "applet", "svg", "math", "head", "title",
    "noscript", "form", "input", "button", "textarea", "select", "audio", "video",
];

fn is_allowed_tag(tag: &str) -> bool {
    ALLOWED_TAGS.contains(&tag)
}

fn is_void_tag(tag: &str) -> bool {
    VOID_TAGS.contains(&tag)
}

fn is_drop_container(tag: &str) -> bool {
    DROP_CONTAINER_TAGS.contains(&tag)
}

/// Convert XDXF (StarDict `x`) markup into simple semantic HTML prior to sanitization.
pub fn xdxf_to_html(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 32);
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut i = 0;

    while i < len {
        if bytes[i] == b'<' {
            if let Some(gt) = find_tag_end(bytes, i + 1) {
                let raw = input[i + 1..gt].trim();
                let is_closing = raw.starts_with('/');
                let body = raw.trim_start_matches('/').trim_end_matches('/').trim();
                let name = body
                    .split(|c: char| c.is_ascii_whitespace() || c == '/')
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let mapped: Option<(&str, &str)> = match name.as_str() {
                    "k" => Some(("<strong>", "</strong><br>")),
                    "tr" => Some(("<span>/", "/</span> ")),
                    "abr" | "ex" | "i" => Some(("<em>", "</em>")),
                    "b" => Some(("<strong>", "</strong>")),
                    "def" | "dtrn" => Some(("<div>", "</div>")),
                    "co" | "c" | "kref" | "iref" => Some(("<span>", "</span>")),
                    "su" => Some(("<sup>", "</sup>")),
                    "sub" => Some(("<sub>", "</sub>")),
                    "br" => Some(("<br>", "")),
                    _ => None,
                };
                if let Some((open, close)) = mapped {
                    out.push_str(if is_closing { close } else { open });
                    i = gt + 1;
                    continue;
                }
            }
        }
        let ch = input[i..].chars().next().unwrap();
        if ch == '\n' {
            out.push_str("<br>");
        } else {
            out.push(ch);
        }
        i += ch.len_utf8();
    }
    sanitize_dictionary_html(&out)
}

/// Convert Pango markup (StarDict `g`) into safe HTML prior to sanitization.
pub fn pango_to_html(input: &str) -> String {
    let replaced = input
        .replace("<big>", "<strong>")
        .replace("</big>", "</strong>")
        .replace("<tt>", "<span>")
        .replace("</tt>", "</span>")
        .replace('\n', "<br>");
    sanitize_dictionary_html(&replaced)
}

/// Sanitize arbitrary dictionary HTML into safe, theme-neutral HTML.
pub fn sanitize_dictionary_html(input: &str) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut out = String::with_capacity(len);
    let mut stack: Vec<&'static str> = Vec::new();
    let mut i = 0;

    while i < len {
        match bytes[i] {
            b'<' => {
                // Comment <!-- ... -->
                if input[i..].starts_with("<!--") {
                    if let Some(end) = input[i + 4..].find("-->") {
                        i = i + 4 + end + 3;
                    } else {
                        break;
                    }
                    continue;
                }
                // DOCTYPE / declaration / PI
                if input[i..].starts_with("<!") || input[i..].starts_with("<?") {
                    if let Some(gt) = find_tag_end(bytes, i + 2) {
                        i = gt + 1;
                        continue;
                    }
                }
                if let Some((tag_name, is_closing, self_closing, next_i)) =
                    parse_tag_header(input, i)
                {
                    let lower = tag_name.to_ascii_lowercase();
                    if !is_closing && !self_closing && is_drop_container(&lower) {
                        i = skip_until_close(input, next_i, &lower);
                        continue;
                    }
                    if is_allowed_tag(&lower) {
                        let static_name = ALLOWED_TAGS
                            .iter()
                            .copied()
                            .find(|&t| t == lower)
                            .unwrap();
                        if is_void_tag(static_name) {
                            if !is_closing {
                                out.push('<');
                                out.push_str(static_name);
                                out.push('>');
                            }
                        } else if is_closing {
                            if let Some(pos) = stack.iter().rposition(|&t| t == static_name) {
                                while stack.len() > pos {
                                    let popped = stack.pop().unwrap();
                                    out.push_str("</");
                                    out.push_str(popped);
                                    out.push('>');
                                }
                            }
                        } else {
                            out.push('<');
                            out.push_str(static_name);
                            out.push('>');
                            if !self_closing {
                                stack.push(static_name);
                            } else {
                                out.push_str("</");
                                out.push_str(static_name);
                                out.push('>');
                            }
                        }
                    }
                    // Disallowed non-container tags (e.g. <img>, <a href>, <font>, <link>)
                    // are stripped while preserving any inner text for non-void ones.
                    i = next_i;
                    continue;
                }
                out.push_str("&lt;");
                i += 1;
            }
            b'>' => {
                out.push_str("&gt;");
                i += 1;
            }
            b'&' => {
                if let Some(end) = valid_entity_end(input, i) {
                    out.push_str(&input[i..end]);
                    i = end;
                } else {
                    out.push_str("&amp;");
                    i += 1;
                }
            }
            _ => {
                let start = i;
                i += 1;
                while i < len && !matches!(bytes[i], b'<' | b'>' | b'&') {
                    i += 1;
                }
                out.push_str(&input[start..i]);
            }
        }
    }

    while let Some(open) = stack.pop() {
        out.push_str("</");
        out.push_str(open);
        out.push('>');
    }

    out.trim().to_string()
}

fn find_tag_end(bytes: &[u8], start: usize) -> Option<usize> {
    let mut i = start;
    let mut quote: Option<u8> = None;
    while i < bytes.len() {
        let b = bytes[i];
        if let Some(q) = quote {
            if b == q {
                quote = None;
            }
        } else {
            match b {
                b'>' => return Some(i),
                b'"' | b'\'' => quote = Some(b),
                _ => {}
            }
        }
        i += 1;
    }
    None
}

fn parse_tag_header(input: &str, start: usize) -> Option<(&str, bool, bool, usize)> {
    let bytes = input.as_bytes();
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
    let gt = find_tag_end(bytes, name_end)?;
    let mut prev = gt;
    while prev > name_end && bytes[prev - 1].is_ascii_whitespace() {
        prev -= 1;
    }
    let self_closing = !is_closing && prev > name_end && bytes[prev - 1] == b'/';
    Some((&input[name_start..name_end], is_closing, self_closing, gt + 1))
}

fn skip_until_close(input: &str, start: usize, tag_lower: &str) -> usize {
    let bytes = input.as_bytes();
    let tlen = tag_lower.len();
    let mut i = start;
    while i + 2 + tlen < bytes.len() {
        if bytes[i] == b'<'
            && bytes[i + 1] == b'/'
            && bytes[i + 2..i + 2 + tlen].eq_ignore_ascii_case(tag_lower.as_bytes())
        {
            let mut j = i + 2 + tlen;
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

fn valid_entity_end(input: &str, start: usize) -> Option<usize> {
    let bytes = input.as_bytes();
    let limit = (start + 16).min(bytes.len());
    for (idx, &b) in bytes.iter().enumerate().take(limit).skip(start + 1) {
        if b == b';' {
            let body = &input[start + 1..idx];
            if body.is_empty() {
                return None;
            }
            if let Some(num) = body.strip_prefix('#') {
                let valid = if let Some(hex) = num.strip_prefix('x').or_else(|| num.strip_prefix('X')) {
                    !hex.is_empty() && hex.bytes().all(|c| c.is_ascii_hexdigit())
                } else {
                    !num.is_empty() && num.bytes().all(|c| c.is_ascii_digit())
                };
                return valid.then_some(idx + 1);
            }
            return body.bytes().all(|c| c.is_ascii_alphanumeric()).then_some(idx + 1);
        }
        if !b.is_ascii_alphanumeric() && b != b'#' {
            return None;
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_scripts_styles_iframes_images_event_handlers_and_inline_colors() {
        let dirty = concat!(
            r#"<style>body { color: #000; background: #fff; }</style>"#,
            r#"<script>alert("xss")</script>"#,
            r#"<iframe src="https://evil.example"></iframe>"#,
            r#"<div style="color:black;background:#ffffff" onclick="steal()">"#,
            r#"<p class="def" style="font-size:9px"><b>mortify</b>: <font color="red">humiliate</font>"#,
            r#"<img src="sound.png" onerror="alert(1)"/>"#,
            r#"<a href="javascript:alert(1)">see also</a></p>"#,
            r#"<ul><li>Sense 1</li><li>Sense 2</li></ul></div>"#
        );
        let clean = sanitize_dictionary_html(dirty);
        assert!(!clean.contains("<script"), "{clean}");
        assert!(!clean.contains("alert"), "{clean}");
        assert!(!clean.contains("<style"), "{clean}");
        assert!(!clean.contains("<iframe"), "{clean}");
        assert!(!clean.contains("<img"), "{clean}");
        assert!(!clean.contains("onclick"), "{clean}");
        assert!(!clean.contains("onerror"), "{clean}");
        assert!(!clean.contains("style="), "{clean}");
        assert!(!clean.contains("color:"), "{clean}");
        assert!(!clean.contains("javascript:"), "{clean}");
        assert_eq!(
            clean,
            "<div><p><b>mortify</b>: humiliatesee also</p><ul><li>Sense 1</li><li>Sense 2</li></ul></div>"
        );
    }

    #[test]
    fn balances_unclosed_tags_and_escapes_stray_brackets() {
        let raw = "<p><b>Open bold with x < 5 & y > 3";
        let clean = sanitize_dictionary_html(raw);
        assert_eq!(clean, "<p><b>Open bold with x &lt; 5 &amp; y &gt; 3</b></p>");
    }

    #[test]
    fn converts_xdxf_and_pango_cleanly() {
        let xdxf = "<k>mortify</k><tr>mɔːtɪfaɪ</tr><dtrn><abr>v.</abr> humiliate</dtrn>";
        let html = xdxf_to_html(xdxf);
        assert!(html.contains("<strong>mortify</strong>"));
        assert!(html.contains("<em>v.</em>"));
        assert!(html.contains("humiliate"));

        let pango = "<span foreground=\"blue\"><big>Title</big>\n<i>italic</i></span>";
        let phtml = pango_to_html(pango);
        assert!(!phtml.contains("foreground"));
        assert_eq!(phtml, "<span><strong>Title</strong><br><i>italic</i></span>");
    }
}
