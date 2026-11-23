//! Read-only reader for Quill's bundled offline dictionary (`dict.db`) and
//! deterministic English lemmatizer (explicit `forms` index + validated suffix fallback).

use std::io::Read;
use std::path::{Path, PathBuf};

use flate2::{Decompress, FlushDecompress, Status};
use rusqlite::{params, Connection, OpenFlags, types::ValueRef};

use super::{AlternateLemma, DictionaryMatch, DictionarySenseGroup};
use crate::error::{AppError, AppResult};

pub const BUILTIN_DICT_ID: &str = "builtin";
pub const BUILTIN_DICT_NAME: &str = "Quill Built-in (EN / ZH)";

pub struct BuiltinDict {
    pub path: PathBuf,
    conn: Connection,
    zdict: Option<Vec<u8>>,
    pub entry_count: u64,
    pub size_bytes: u64,
}

#[derive(Debug, Clone)]
pub struct LemmatizeOutput {
    pub lemma: String,
    pub lang: String,
    pub inflected_from: Option<String>,
    pub alternate_lemmas: Vec<AlternateLemma>,
    pub forms: Vec<String>,
    pub matched_entry_id: Option<i64>,
}

impl BuiltinDict {
    pub fn open(path: &Path) -> AppResult<Self> {
        let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        let zdict: Option<Vec<u8>> = conn
            .query_row("SELECT value FROM meta WHERE key = 'senses_zdict'", [], |r| {
                r.get(0)
            })
            .ok();
        let entry_count: u64 = conn
            .query_row("SELECT value FROM meta WHERE key = 'entry_count'", [], |r| {
                let raw: Vec<u8> = r.get(0)?;
                Ok(String::from_utf8_lossy(&raw).trim().parse::<u64>().unwrap_or(0))
            })
            .ok()
            .filter(|&n| n > 0)
            .unwrap_or_else(|| {
                conn.query_row("SELECT COUNT(*) FROM entries", [], |r| r.get::<_, i64>(0))
                    .map(|c| c.max(0) as u64)
                    .unwrap_or(0)
            });

        Ok(Self {
            path: path.to_path_buf(),
            conn,
            zdict,
            entry_count,
            size_bytes,
        })
    }

    pub fn lemmatize(
        &self,
        raw_term: &str,
        lang_hint: Option<&str>,
        lemmatize_enabled: bool,
    ) -> AppResult<LemmatizeOutput> {
        let trimmed = raw_term.trim();
        let lang = detect_lang(trimmed, lang_hint);

        if lang == "zh" {
            return self.lemmatize_zh(trimmed);
        }
        self.lemmatize_en(trimmed, lemmatize_enabled)
    }

    fn lemmatize_zh(&self, trimmed: &str) -> AppResult<LemmatizeOutput> {
        let mut stmt = self.conn.prepare(
            "SELECT f.entry_id, f.is_lemma, f.relation, e.lemma
             FROM forms f
             JOIN entries e ON e.id = f.entry_id
             WHERE f.form = ?1 AND f.lang = 'zh'
             ORDER BY f.is_lemma DESC, f.entry_id ASC",
        )?;
        let rows: Vec<(i64, i64, Option<String>, String)> = stmt
            .query_map(params![trimmed], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        if let Some((entry_id, is_lemma, _rel, lemma)) = rows.first() {
            let inflected_from = (*is_lemma == 0 && lemma != trimmed).then(|| trimmed.to_string());
            let forms = self.load_forms(*entry_id, lemma, inflected_from.as_deref())?;
            return Ok(LemmatizeOutput {
                lemma: lemma.clone(),
                lang: "zh".to_string(),
                inflected_from,
                alternate_lemmas: Vec::new(),
                forms,
                matched_entry_id: Some(*entry_id),
            });
        }

        // Direct check in entries table in case forms row wasn't populated
        if let Ok((entry_id, lemma)) = self.conn.query_row(
            "SELECT id, lemma FROM entries WHERE lang = 'zh' AND lemma = ?1 LIMIT 1",
            params![trimmed],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        ) {
            let forms = self.load_forms(entry_id, &lemma, None)?;
            return Ok(LemmatizeOutput {
                lemma,
                lang: "zh".to_string(),
                inflected_from: None,
                alternate_lemmas: Vec::new(),
                forms,
                matched_entry_id: Some(entry_id),
            });
        }

        Ok(LemmatizeOutput {
            lemma: trimmed.to_string(),
            lang: "zh".to_string(),
            inflected_from: None,
            alternate_lemmas: Vec::new(),
            forms: vec![trimmed.to_string()],
            matched_entry_id: None,
        })
    }

    fn lemmatize_en(&self, trimmed: &str, lemmatize_enabled: bool) -> AppResult<LemmatizeOutput> {
        let lower = trimmed.to_lowercase();
        if !lemmatize_enabled {
            let direct: Option<(i64, String)> = self
                .conn
                .query_row(
                    "SELECT f.entry_id, e.lemma
                     FROM forms f
                     JOIN entries e ON e.id = f.entry_id
                     WHERE f.form = ?1 AND f.lang = 'en' AND f.is_lemma = 1
                     ORDER BY f.entry_id ASC LIMIT 1",
                    params![lower],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .ok();
            return Ok(match direct {
                Some((entry_id, lemma)) => LemmatizeOutput {
                    forms: vec![lemma.clone()],
                    lemma,
                    lang: "en".to_string(),
                    inflected_from: None,
                    alternate_lemmas: Vec::new(),
                    matched_entry_id: Some(entry_id),
                },
                None => LemmatizeOutput {
                    lemma: trimmed.to_string(),
                    lang: "en".to_string(),
                    inflected_from: None,
                    alternate_lemmas: Vec::new(),
                    forms: vec![trimmed.to_string()],
                    matched_entry_id: None,
                },
            });
        }

        let mut stmt = self.conn.prepare(
            "SELECT f.entry_id, f.is_lemma, f.relation, e.lemma
             FROM forms f
             JOIN entries e ON e.id = f.entry_id
             WHERE f.form = ?1 AND f.lang = 'en'
             ORDER BY f.is_lemma DESC, f.entry_id ASC",
        )?;
        let rows: Vec<(i64, i64, Option<String>, String)> = stmt
            .query_map(params![lower], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;

        if !rows.is_empty() {
            let (primary_id, primary_is_lemma, _primary_rel, primary_lemma) = &rows[0];
            let inflected_from = (*primary_is_lemma == 0
                && !primary_lemma.eq_ignore_ascii_case(trimmed))
            .then(|| trimmed.to_string());

            let mut alternate_lemmas = Vec::new();
            let mut seen_alt = std::collections::HashSet::new();
            seen_alt.insert(primary_lemma.to_lowercase());
            for (_eid, _is_l, rel, alt_lemma) in rows.iter().skip(1) {
                let key = alt_lemma.to_lowercase();
                if seen_alt.insert(key) {
                    alternate_lemmas.push(AlternateLemma {
                        lemma: alt_lemma.clone(),
                        relation: rel
                            .clone()
                            .unwrap_or_else(|| "inflected form".to_string()),
                    });
                }
            }

            let forms = self.load_forms(*primary_id, primary_lemma, inflected_from.as_deref())?;
            return Ok(LemmatizeOutput {
                lemma: primary_lemma.clone(),
                lang: "en".to_string(),
                inflected_from,
                alternate_lemmas,
                forms,
                matched_entry_id: Some(*primary_id),
            });
        }

        // Suffix-rule fallback validated against known English lemmas in entries
        if let Some((entry_id, lemma)) = self.try_english_suffix_fallback(&lower)? {
            let inflected_from = (!lemma.eq_ignore_ascii_case(trimmed)).then(|| trimmed.to_string());
            let forms = self.load_forms(entry_id, &lemma, inflected_from.as_deref())?;
            return Ok(LemmatizeOutput {
                lemma,
                lang: "en".to_string(),
                inflected_from,
                alternate_lemmas: Vec::new(),
                forms,
                matched_entry_id: Some(entry_id),
            });
        }

        Ok(LemmatizeOutput {
            lemma: trimmed.to_string(),
            lang: "en".to_string(),
            inflected_from: None,
            alternate_lemmas: Vec::new(),
            forms: vec![trimmed.to_string()],
            matched_entry_id: None,
        })
    }

    fn try_english_suffix_fallback(&self, lower: &str) -> AppResult<Option<(i64, String)>> {
        if lower.len() < 3 || !lower.is_ascii() {
            return Ok(None);
        }
        let mut candidates: Vec<String> = Vec::new();

        // -ies -> -y
        if let Some(stem) = lower.strip_suffix("ies") {
            if !stem.is_empty() {
                candidates.push(format!("{stem}y"));
            }
        }
        // -ied -> -y
        if let Some(stem) = lower.strip_suffix("ied") {
            if !stem.is_empty() {
                candidates.push(format!("{stem}y"));
            }
        }
        // -ing
        if let Some(stem) = lower.strip_suffix("ing") {
            if stem.len() >= 2 {
                if let Some(y_stem) = stem.strip_suffix('y') {
                    candidates.push(format!("{y_stem}ie"));
                }
                candidates.push(stem.to_string());
                candidates.push(format!("{stem}e"));
                if ends_with_double_consonant(stem) {
                    candidates.push(stem[..stem.len() - 1].to_string());
                }
            }
        }
        // -ed
        if let Some(stem) = lower.strip_suffix("ed") {
            if stem.len() >= 2 {
                candidates.push(stem.to_string());
                candidates.push(format!("{stem}e"));
                if ends_with_double_consonant(stem) {
                    candidates.push(stem[..stem.len() - 1].to_string());
                }
            }
        }
        // -es
        if let Some(stem) = lower.strip_suffix("es") {
            if stem.len() >= 2 {
                candidates.push(stem.to_string());
                candidates.push(format!("{stem}e"));
            }
        }
        // -s (skip words ending in -ss)
        if let Some(stem) = lower.strip_suffix('s') {
            if stem.len() >= 2 && !stem.ends_with('s') {
                candidates.push(stem.to_string());
            }
        }
        // -ier / -iest -> -y, -er / -est
        if let Some(stem) = lower.strip_suffix("ier") {
            if stem.len() >= 2 {
                candidates.push(format!("{stem}y"));
            }
        }
        if let Some(stem) = lower.strip_suffix("iest") {
            if stem.len() >= 2 {
                candidates.push(format!("{stem}y"));
            }
        }

        let mut stmt = self.conn.prepare(
            "SELECT id, lemma FROM entries WHERE lang = 'en' AND lemma = ?1 COLLATE NOCASE LIMIT 1",
        )?;
        for cand in candidates {
            if let Ok(hit) = stmt.query_row(params![cand], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
            }) {
                return Ok(Some(hit));
            }
        }
        Ok(None)
    }

    fn load_forms(
        &self,
        entry_id: i64,
        lemma: &str,
        inflected_from: Option<&str>,
    ) -> AppResult<Vec<String>> {
        let mut stmt = self
            .conn
            .prepare("SELECT DISTINCT form FROM forms WHERE entry_id = ?1")?;
        let mut forms: Vec<String> = stmt
            .query_map(params![entry_id], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        if !forms.iter().any(|f| f.eq_ignore_ascii_case(lemma)) {
            forms.insert(0, lemma.to_string());
        }
        if let Some(inf) = inflected_from {
            if !forms.iter().any(|f| f.eq_ignore_ascii_case(inf)) {
                forms.push(inf.to_string());
            }
        }
        Ok(forms)
    }

    pub fn fetch_entry_by_id(&self, entry_id: i64) -> AppResult<Option<DictionaryMatch>> {
        let mut stmt = self.conn.prepare(
            "SELECT pron, senses_json, gloss_en, gloss_zh FROM entries WHERE id = ?1 LIMIT 1",
        )?;
        let row = stmt
            .query_map(params![entry_id], |r| {
                let pron: Option<String> = r.get(0)?;
                let senses_raw: Vec<u8> = match r.get_ref(1)? {
                    ValueRef::Text(bytes) | ValueRef::Blob(bytes) => bytes.to_vec(),
                    _ => Vec::new(),
                };
                let gloss_en: Option<String> = r.get(2)?;
                let gloss_zh: Option<String> = r.get(3)?;
                Ok((pron, senses_raw, gloss_en, gloss_zh))
            })?
            .next()
            .transpose()?;

        let Some((pron, senses_raw, gloss_en, gloss_zh)) = row else {
            return Ok(None);
        };
        let json_str = self.decode_senses(&senses_raw)?;
        let senses: Vec<DictionarySenseGroup> = serde_json::from_str(&json_str)
            .map_err(|e| AppError::Other(format!("Invalid built-in dictionary senses JSON: {e}")))?;

        Ok(Some(DictionaryMatch {
            dict_id: BUILTIN_DICT_ID.to_string(),
            dict_name: BUILTIN_DICT_NAME.to_string(),
            format: "builtin".to_string(),
            pronunciation: pron,
            senses: Some(senses),
            html: None,
            plain_text: None,
            gloss_en,
            gloss_zh,
        }))
    }

    fn decode_senses(&self, raw: &[u8]) -> AppResult<String> {
        if raw.is_empty() {
            return Ok("[]".to_string());
        }
        if raw[0] == b'[' {
            return String::from_utf8(raw.to_vec())
                .map_err(|e| AppError::Other(format!("Invalid UTF-8 senses: {e}")));
        }
        if raw[0] == 0x02 {
            // Raw deflate with preset dictionary from meta.senses_zdict
            let zdict = self.zdict.as_deref().ok_or_else(|| {
                AppError::Other("Built-in dict.db missing senses_zdict metadata".into())
            })?;
            return inflate_raw_with_dict(&raw[1..], Some(zdict));
        }
        if raw[0] == 0x01 {
            return inflate_raw_with_dict(&raw[1..], None);
        }
        // Standard zlib stream fallback (0x78 ...)
        let mut decoder = flate2::read::ZlibDecoder::new(raw);
        let mut out = String::new();
        decoder
            .read_to_string(&mut out)
            .map_err(|e| AppError::Other(format!("Failed to decompress senses: {e}")))?;
        Ok(out)
    }
}

fn inflate_raw_with_dict(input: &[u8], zdict: Option<&[u8]>) -> AppResult<String> {
    let mut decompressor = Decompress::new(false);
    if let Some(dict) = zdict {
        decompressor
            .set_dictionary(dict)
            .map_err(|e| AppError::Other(format!("set_dictionary failed: {e}")))?;
    }
    let mut out = Vec::with_capacity(input.len().saturating_mul(3).max(256));
    let mut buf = [0u8; 4096];
    let mut offset = 0;
    loop {
        let before_in = decompressor.total_in();
        let before_out = decompressor.total_out();
        let status = decompressor
            .decompress(&input[offset..], &mut buf, FlushDecompress::Finish)
            .map_err(|e| AppError::Other(format!("Deflate decompress error: {e}")))?;
        let consumed = (decompressor.total_in() - before_in) as usize;
        let produced = (decompressor.total_out() - before_out) as usize;
        offset += consumed;
        out.extend_from_slice(&buf[..produced]);
        match status {
            Status::StreamEnd => break,
            Status::Ok => {
                if consumed == 0 && produced == 0 {
                    break;
                }
            }
            Status::BufError => {
                if produced == 0 {
                    break;
                }
            }
        }
    }
    String::from_utf8(out)
        .map_err(|e| AppError::Other(format!("Invalid UTF-8 in decompressed senses: {e}")))
}

fn ends_with_double_consonant(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() < 2 {
        return false;
    }
    let last = b[b.len() - 1];
    let prev = b[b.len() - 2];
    last == prev && last.is_ascii_alphabetic() && !matches!(last, b'a' | b'e' | b'i' | b'o' | b'u')
}

pub fn detect_lang(term: &str, lang_hint: Option<&str>) -> String {
    if let Some(hint) = lang_hint.map(str::trim).filter(|s| !s.is_empty()) {
        if hint.starts_with("zh") {
            return "zh".to_string();
        }
        if hint.starts_with("en") {
            return "en".to_string();
        }
    }
    if term.chars().any(is_hanzi) {
        "zh".to_string()
    } else {
        "en".to_string()
    }
}

fn is_hanzi(c: char) -> bool {
    matches!(
        c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0x20000..=0x2A6DF
    )
}
