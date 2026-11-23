//! Offline dictionary engine: bundled EN/ZH dictionary (`dict.db`),
//! deterministic English lemmatizer, and user-imported StarDict / MDict support.

pub mod builtin;
pub mod mdict;
pub mod sanitize;
pub mod stardict;

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use rusqlite::params;
use serde::{Deserialize, Serialize};

use crate::db::Db;
use crate::dictionary::builtin::{BuiltinDict, BUILTIN_DICT_ID, BUILTIN_DICT_NAME};
use crate::error::{AppError, AppResult};

pub const SETTING_DICTIONARIES_CONFIG: &str = "dictionaries_config";
pub const SETTING_DICTIONARY_LEMMATIZE: &str = "dictionary_lemmatize";
pub const SETTING_DICTIONARY_SHOW_ALL_MATCHES: &str = "dictionary_show_all_matches";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DictionarySenseGroup {
    pub pos: String,
    pub defs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AlternateLemma {
    pub lemma: String,
    pub relation: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryMatch {
    pub dict_id: String,
    pub dict_name: String,
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pronunciation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub senses: Option<Vec<DictionarySenseGroup>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub html: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plain_text: Option<String>,
    #[serde(rename = "gloss_en", skip_serializing_if = "Option::is_none")]
    pub gloss_en: Option<String>,
    #[serde(rename = "gloss_zh", skip_serializing_if = "Option::is_none")]
    pub gloss_zh: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LookupDictionaryResult {
    pub lemma: String,
    pub lang: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inflected_from: Option<String>,
    pub alternate_lemmas: Vec<AlternateLemma>,
    pub forms: Vec<String>,
    pub matches: Vec<DictionaryMatch>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryDescriptor {
    pub id: String,
    pub name: String,
    pub format: String,
    pub size_bytes: u64,
    pub entry_count: u64,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryConfigItem {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub format: Option<String>,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub entry_count: Option<u64>,
    pub enabled: bool,
}

pub(crate) struct ImportedDictMeta {
    pub name: String,
    pub format: String,
    pub size_bytes: u64,
    pub entry_count: u64,
}

pub struct DictionaryManager {
    builtin_path: Option<PathBuf>,
    imported_dir: PathBuf,
    builtin_cache: Mutex<Option<Option<BuiltinDict>>>,
    registry_lock: Mutex<()>,
}

fn is_valid_imported_id(id: &str) -> bool {
    id.strip_prefix("dict-")
        .is_some_and(|rest| uuid::Uuid::parse_str(rest).is_ok())
}

impl DictionaryManager {
    pub fn new(builtin_path: Option<PathBuf>, imported_dir: PathBuf) -> Self {
        Self {
            builtin_path,
            imported_dir,
            builtin_cache: Mutex::new(None),
            registry_lock: Mutex::new(()),
        }
    }

    fn with_builtin<F, R>(&self, f: F) -> AppResult<Option<R>>
    where
        F: FnOnce(&BuiltinDict) -> AppResult<R>,
    {
        let mut guard = self
            .builtin_cache
            .lock()
            .map_err(|e| AppError::Other(format!("dictionary mutex: {e}")))?;

        if guard.is_none() {
            let opened = match self.builtin_path.as_ref().filter(|p| p.exists()) {
                Some(path) => match BuiltinDict::open(path) {
                    Ok(db) => Some(db),
                    Err(err) => {
                        log::warn!("dictionary: failed to open built-in {}: {err}", path.display());
                        None
                    }
                },
                None => None,
            };
            *guard = Some(opened);
        }

        match guard.as_ref().and_then(|o| o.as_ref()) {
            Some(dict) => Ok(Some(f(dict)?)),
            None => Ok(None),
        }
    }

    fn builtin_metadata(&self) -> (u64, u64) {
        self.with_builtin(|b| Ok((b.size_bytes, b.entry_count)))
            .ok()
            .flatten()
            .unwrap_or((0, 0))
    }

    pub fn list_dictionaries(&self, db: &Db) -> AppResult<Vec<DictionaryDescriptor>> {
        let _guard = self
            .registry_lock
            .lock()
            .map_err(|e| AppError::Other(format!("dictionary registry mutex: {e}")))?;
        self.list_dictionaries_locked(db)
    }

    fn list_dictionaries_locked(&self, db: &Db) -> AppResult<Vec<DictionaryDescriptor>> {
        let (builtin_size, builtin_entries) = self.builtin_metadata();
        let raw_cfg = read_setting(db, SETTING_DICTIONARIES_CONFIG)?;
        let parsed: Vec<DictionaryDescriptor> = raw_cfg
            .as_deref()
            .and_then(|s| serde_json::from_str::<Vec<DictionaryDescriptor>>(s).ok())
            .unwrap_or_default();

        let mut list: Vec<DictionaryDescriptor> = Vec::new();
        let mut seen = HashSet::new();
        let mut has_builtin = false;

        for mut item in parsed {
            if !seen.insert(item.id.clone()) {
                continue;
            }
            if item.id == BUILTIN_DICT_ID {
                item.name = BUILTIN_DICT_NAME.to_string();
                item.format = "builtin".to_string();
                item.size_bytes = builtin_size;
                item.entry_count = builtin_entries;
                has_builtin = true;
                list.push(item);
            } else if is_valid_imported_id(&item.id) {
                let dir = self.imported_dir.join(&item.id);
                if dir.join("index.db").exists() {
                    list.push(item);
                }
            }
        }

        if !has_builtin {
            list.insert(
                0,
                DictionaryDescriptor {
                    id: BUILTIN_DICT_ID.to_string(),
                    name: BUILTIN_DICT_NAME.to_string(),
                    format: "builtin".to_string(),
                    size_bytes: builtin_size,
                    entry_count: builtin_entries,
                    enabled: true,
                },
            );
        }

        Ok(list)
    }

    pub fn update_dictionaries_config(
        &self,
        db: &Db,
        items: Vec<DictionaryConfigItem>,
    ) -> AppResult<Vec<DictionaryDescriptor>> {
        let _guard = self
            .registry_lock
            .lock()
            .map_err(|e| AppError::Other(format!("dictionary registry mutex: {e}")))?;
        let current = self.list_dictionaries_locked(db)?;
        let by_id: std::collections::HashMap<String, DictionaryDescriptor> =
            current.iter().map(|d| (d.id.clone(), d.clone())).collect();

        let mut next: Vec<DictionaryDescriptor> = Vec::new();
        let mut seen = HashSet::new();
        for item in items {
            if !seen.insert(item.id.clone()) {
                continue;
            }
            if let Some(mut existing) = by_id.get(&item.id).cloned() {
                existing.enabled = item.enabled;
                next.push(existing);
            }
        }
        // Preserve every currently installed dictionary (built-in and any
        // concurrently imported dictionaries omitted from a stale reorder).
        for existing in current {
            if !seen.contains(&existing.id) {
                next.push(existing);
            }
        }

        write_dictionaries_config(db, &next)?;
        Ok(next)
    }

    pub fn import_dictionary(&self, db: &Db, path: &Path) -> AppResult<DictionaryDescriptor> {
        if !path.exists() {
            return Err(AppError::Other(format!(
                "Dictionary path does not exist: {}",
                path.display()
            )));
        }

        let id = format!("dict-{}", uuid::Uuid::new_v4());
        let dest_dir = self.imported_dir.join(&id);
        fs::create_dir_all(&self.imported_dir)?;

        let ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.to_ascii_lowercase())
            .unwrap_or_default();

        let result = if path.is_file() && ext == "mdx" {
            mdict::import_mdict(path, &dest_dir)
        } else if path.is_dir() || ext == "ifo" || ext == "zip" {
            stardict::import_stardict(path, &dest_dir)
        } else {
            Err(AppError::Other(
                "Unsupported dictionary file. Select a StarDict (.ifo, folder, or .zip) or unencrypted MDict (.mdx v1.2/v2.0) file."
                    .into(),
            ))
        };

        let meta = match result {
            Ok(meta) => meta,
            Err(err) => {
                let _ = fs::remove_dir_all(&dest_dir);
                return Err(err);
            }
        };

        let descriptor = DictionaryDescriptor {
            id,
            name: meta.name,
            format: meta.format,
            size_bytes: meta.size_bytes,
            entry_count: meta.entry_count,
            enabled: true,
        };

        let _guard = self
            .registry_lock
            .lock()
            .map_err(|e| AppError::Other(format!("dictionary registry mutex: {e}")))?;
        let mut list = self.list_dictionaries_locked(db)?;
        list.push(descriptor.clone());
        if let Err(err) = write_dictionaries_config(db, &list) {
            let _ = fs::remove_dir_all(&dest_dir);
            return Err(err);
        }
        Ok(descriptor)
    }

    pub fn remove_dictionary(&self, db: &Db, id: &str) -> AppResult<Vec<DictionaryDescriptor>> {
        if id == BUILTIN_DICT_ID {
            return Err(AppError::Other(
                "The built-in dictionary cannot be removed; disable it instead.".into(),
            ));
        }
        if !is_valid_imported_id(id) {
            return Err(AppError::Other(format!("Invalid dictionary id: {id}")));
        }

        let _guard = self
            .registry_lock
            .lock()
            .map_err(|e| AppError::Other(format!("dictionary registry mutex: {e}")))?;
        let mut list = self.list_dictionaries_locked(db)?;
        if !list.iter().any(|d| d.id == id) {
            return Err(AppError::Other(format!("Dictionary not found: {id}")));
        }

        let dir = self.imported_dir.join(id);
        if dir.parent() != Some(self.imported_dir.as_path()) {
            return Err(AppError::Other(format!("Invalid dictionary path for id: {id}")));
        }
        match fs::symlink_metadata(&dir) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err(AppError::Other(
                        "Refusing to remove symlinked dictionary directory".into(),
                    ));
                }
                fs::remove_dir_all(&dir)?;
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
            Err(err) => return Err(err.into()),
        }

        list.retain(|d| d.id != id);
        write_dictionaries_config(db, &list)?;
        Ok(list)
    }

    pub fn lookup_dictionary(
        &self,
        db: &Db,
        term: &str,
        lang_hint: Option<&str>,
    ) -> AppResult<LookupDictionaryResult> {
        let trimmed = term.trim();
        if trimmed.is_empty() {
            return Ok(LookupDictionaryResult {
                lemma: String::new(),
                lang: builtin::detect_lang("", lang_hint),
                inflected_from: None,
                alternate_lemmas: Vec::new(),
                forms: Vec::new(),
                matches: Vec::new(),
            });
        }

        let lemmatize_enabled = read_setting(db, SETTING_DICTIONARY_LEMMATIZE)?
            .as_deref()
            .is_none_or(|v| v != "false");

        // 1. Lemmatization runs first against built-in index even if custom dicts are above
        //    built-in or built-in display is toggled off.
        let lem = self
            .with_builtin(|b| b.lemmatize(trimmed, lang_hint, lemmatize_enabled))?
            .unwrap_or_else(|| builtin::LemmatizeOutput {
                lemma: trimmed.to_string(),
                lang: builtin::detect_lang(trimmed, lang_hint),
                inflected_from: None,
                alternate_lemmas: Vec::new(),
                forms: vec![trimmed.to_string()],
                matched_entry_id: None,
            });

        // 2. Query enabled dictionaries in priority order, isolating failures in any
        //    individual imported source so healthy sources and built-in still return.
        let dicts = self.list_dictionaries(db)?;
        let mut matches = Vec::new();
        for dict in dicts {
            if !dict.enabled {
                continue;
            }
            if dict.id == BUILTIN_DICT_ID {
                if let Some(entry_id) = lem.matched_entry_id {
                    if let Some(Some(m)) = self.with_builtin(|b| b.fetch_entry_by_id(entry_id))? {
                        matches.push(m);
                    }
                }
            } else if is_valid_imported_id(&dict.id) {
                let dir = self.imported_dir.join(&dict.id);
                match self.query_imported(&dir, &dict, &lem.lemma, trimmed) {
                    Ok(Some(m)) => matches.push(m),
                    Ok(None) => {}
                    Err(err) => {
                        log::warn!(
                            "dictionary: lookup failed for imported dictionary {} ({}): {err}",
                            dict.id,
                            dict.name
                        );
                    }
                }
            }
        }

        Ok(LookupDictionaryResult {
            lemma: lem.lemma,
            lang: lem.lang,
            inflected_from: lem.inflected_from,
            alternate_lemmas: lem.alternate_lemmas,
            forms: lem.forms,
            matches,
        })
    }

    fn query_imported(
        &self,
        dir: &Path,
        dict: &DictionaryDescriptor,
        lemma: &str,
        raw_term: &str,
    ) -> AppResult<Option<DictionaryMatch>> {
        let query_one = |q: &str| -> AppResult<Option<DictionaryMatch>> {
            match dict.format.as_str() {
                "stardict" => stardict::query_stardict(dir, &dict.id, &dict.name, q),
                "mdx" => mdict::query_mdict(dir, &dict.id, &dict.name, q),
                _ => Ok(None),
            }
        };

        if let Some(hit) = query_one(lemma)? {
            return Ok(Some(hit));
        }
        if !raw_term.eq_ignore_ascii_case(lemma) {
            return query_one(raw_term);
        }
        Ok(None)
    }
}

fn read_setting(db: &Db, key: &str) -> AppResult<Option<String>> {
    let conn = db.reader();
    match conn.query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
        r.get::<_, String>(0)
    }) {
        Ok(val) => Ok(Some(val)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

fn write_dictionaries_config(db: &Db, list: &[DictionaryDescriptor]) -> AppResult<()> {
    let json = serde_json::to_string(list)
        .map_err(|e| AppError::Other(format!("Serialize dictionaries_config: {e}")))?;
    let conn = db
        .conn
        .lock()
        .map_err(|e| AppError::Other(format!("db mutex: {e}")))?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![SETTING_DICTIONARIES_CONFIG, json],
    )?;
    Ok(())
}

pub(crate) fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                total += fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
            } else if p.is_dir() {
                total += dir_size_bytes(&p);
            }
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::{DeflateEncoder, ZlibEncoder};
    use flate2::Compression;
    use std::io::Write;
    use tempfile::TempDir;

    fn fixture_dict_path() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("dict-test.db")
    }

    fn setup_manager(with_builtin: bool) -> (TempDir, Db, DictionaryManager) {
        let dir = TempDir::new().unwrap();
        let db = Db::init(dir.path()).unwrap();
        let builtin = with_builtin.then(fixture_dict_path);
        let mgr = DictionaryManager::new(builtin, dir.path().join("dictionaries"));
        (dir, db, mgr)
    }

    fn create_stardict_dir(
        dir: &Path,
        name: &str,
        same_type_sequence: &str,
        entries: &[(&str, &str)],
        use_dictzip: bool,
    ) -> PathBuf {
        let mut dict_bytes = Vec::new();
        let mut idx_bytes = Vec::new();
        for (word, def) in entries {
            let offset = dict_bytes.len() as u32;
            dict_bytes.extend_from_slice(def.as_bytes());
            let size = def.len() as u32;
            idx_bytes.extend_from_slice(word.as_bytes());
            idx_bytes.push(0);
            idx_bytes.extend_from_slice(&offset.to_be_bytes());
            idx_bytes.extend_from_slice(&size.to_be_bytes());
        }

        let ifo_path = dir.join("test.ifo");
        let ifo = format!(
            "StarDict's dict ifo file\nversion=2.4.2\nwordcount={}\nidxfilesize={}\nbookname={}\nsametypesequence={}\n",
            entries.len(),
            idx_bytes.len(),
            name,
            same_type_sequence,
        );
        fs::write(&ifo_path, ifo).unwrap();
        fs::write(dir.join("test.idx"), &idx_bytes).unwrap();

        if use_dictzip {
            // Build a valid RFC 1952 dictzip with one RA chunk
            let mut enc = DeflateEncoder::new(Vec::new(), Compression::default());
            enc.write_all(&dict_bytes).unwrap();
            let comp = enc.finish().unwrap();

            let mut dz = Vec::new();
            dz.extend_from_slice(&[0x1F, 0x8B, 0x08, 0x04, 0, 0, 0, 0, 0, 0]);
            let slen: u16 = 8; // ver(2) + chlen(2) + chcnt(2) + chunk0(2)
            let xlen: u16 = 4 + slen;
            dz.extend_from_slice(&xlen.to_le_bytes());
            dz.extend_from_slice(b"RA");
            dz.extend_from_slice(&slen.to_le_bytes());
            dz.extend_from_slice(&1u16.to_le_bytes()); // ver
            dz.extend_from_slice(&(dict_bytes.len().max(1) as u16).to_le_bytes()); // chlen
            dz.extend_from_slice(&1u16.to_le_bytes()); // chcnt
            dz.extend_from_slice(&(comp.len() as u16).to_le_bytes());
            dz.extend_from_slice(&comp);
            fs::write(dir.join("test.dict.dz"), dz).unwrap();
        } else {
            fs::write(dir.join("test.dict"), &dict_bytes).unwrap();
        }
        ifo_path
    }

    fn build_synthetic_mdx(
        path: &Path,
        version: &str,
        encrypted: &str,
        title: &str,
        entries: &[(&str, &str)],
    ) {
        let header_xml = format!(
            r#"<Dictionary GeneratedByEngineVersion="{version}" RequiredEngineVersion="{version}" Encrypted="{encrypted}" Encoding="UTF-8" Format="Html" Title="{title}" Description="Synthetic test"/>"#
        );
        let mut header_utf16: Vec<u8> = Vec::new();
        for u in header_xml.encode_utf16() {
            header_utf16.extend_from_slice(&u.to_le_bytes());
        }
        header_utf16.extend_from_slice(&[0, 0]);

        let is_v2 = version.parse::<f32>().unwrap_or(2.0) >= 2.0;

        let mut out = Vec::new();
        out.extend_from_slice(&(header_utf16.len() as u32).to_be_bytes());
        out.extend_from_slice(&header_utf16);
        out.extend_from_slice(&[0u8; 4]); // adler placeholder

        if version.parse::<f32>().unwrap_or(2.0) >= 3.0 || encrypted == "1" || encrypted == "Yes" {
            fs::write(path, out).unwrap();
            return;
        }

        // Build record data + key block data
        let mut rec_plain = Vec::new();
        let mut key_plain = Vec::new();
        for (word, html) in entries {
            let offset = rec_plain.len() as u64;
            if is_v2 {
                key_plain.extend_from_slice(&offset.to_be_bytes());
            } else {
                key_plain.extend_from_slice(&(offset as u32).to_be_bytes());
            }
            key_plain.extend_from_slice(word.as_bytes());
            key_plain.push(0);

            rec_plain.extend_from_slice(html.as_bytes());
            rec_plain.push(0);
        }

        let zlib_block = |plain: &[u8]| -> Vec<u8> {
            let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
            enc.write_all(plain).unwrap();
            let comp = enc.finish().unwrap();
            let mut blk = Vec::with_capacity(8 + comp.len());
            blk.extend_from_slice(&0x0200_0000u32.to_be_bytes());
            blk.extend_from_slice(&[0u8; 4]); // adler
            blk.extend_from_slice(&comp);
            blk
        };

        let key_block = zlib_block(&key_plain);
        let rec_block = zlib_block(&rec_plain);

        let first_word = entries.first().map(|e| e.0).unwrap_or("");
        let last_word = entries.last().map(|e| e.0).unwrap_or("");

        let mut key_info_plain = Vec::new();
        if is_v2 {
            key_info_plain.extend_from_slice(&(entries.len() as u64).to_be_bytes());
            key_info_plain.extend_from_slice(&(first_word.len() as u16).to_be_bytes());
            key_info_plain.extend_from_slice(first_word.as_bytes());
            key_info_plain.push(0);
            key_info_plain.extend_from_slice(&(last_word.len() as u16).to_be_bytes());
            key_info_plain.extend_from_slice(last_word.as_bytes());
            key_info_plain.push(0);
            key_info_plain.extend_from_slice(&(key_block.len() as u64).to_be_bytes());
            key_info_plain.extend_from_slice(&(key_plain.len() as u64).to_be_bytes());
        } else {
            key_info_plain.extend_from_slice(&(entries.len() as u32).to_be_bytes());
            key_info_plain.push(first_word.len() as u8);
            key_info_plain.extend_from_slice(first_word.as_bytes());
            key_info_plain.push(last_word.len() as u8);
            key_info_plain.extend_from_slice(last_word.as_bytes());
            key_info_plain.extend_from_slice(&(key_block.len() as u32).to_be_bytes());
            key_info_plain.extend_from_slice(&(key_plain.len() as u32).to_be_bytes());
        }

        let key_info_encoded = if is_v2 {
            zlib_block(&key_info_plain)
        } else {
            key_info_plain.clone()
        };

        if is_v2 {
            out.extend_from_slice(&1u64.to_be_bytes());
            out.extend_from_slice(&(entries.len() as u64).to_be_bytes());
            out.extend_from_slice(&(key_info_plain.len() as u64).to_be_bytes());
            out.extend_from_slice(&(key_info_encoded.len() as u64).to_be_bytes());
            out.extend_from_slice(&(key_block.len() as u64).to_be_bytes());
            out.extend_from_slice(&[0u8; 4]); // key header adler
        } else {
            out.extend_from_slice(&1u32.to_be_bytes());
            out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
            out.extend_from_slice(&(key_info_encoded.len() as u32).to_be_bytes());
            out.extend_from_slice(&(key_block.len() as u32).to_be_bytes());
        }
        out.extend_from_slice(&key_info_encoded);
        out.extend_from_slice(&key_block);

        // Record section
        if is_v2 {
            out.extend_from_slice(&1u64.to_be_bytes());
            out.extend_from_slice(&(entries.len() as u64).to_be_bytes());
            out.extend_from_slice(&16u64.to_be_bytes());
            out.extend_from_slice(&(rec_block.len() as u64).to_be_bytes());
            out.extend_from_slice(&(rec_block.len() as u64).to_be_bytes());
            out.extend_from_slice(&(rec_plain.len() as u64).to_be_bytes());
        } else {
            out.extend_from_slice(&1u32.to_be_bytes());
            out.extend_from_slice(&(entries.len() as u32).to_be_bytes());
            out.extend_from_slice(&8u32.to_be_bytes());
            out.extend_from_slice(&(rec_block.len() as u32).to_be_bytes());
            out.extend_from_slice(&(rec_block.len() as u32).to_be_bytes());
            out.extend_from_slice(&(rec_plain.len() as u32).to_be_bytes());
        }
        out.extend_from_slice(&rec_block);

        fs::write(path, out).unwrap();
    }

    #[test]
    fn lemmatizes_regular_irregular_suffix_fallback_and_homographs() {
        let (_dir, db, mgr) = setup_manager(true);

        // Irregular & form_of index
        let r = mgr.lookup_dictionary(&db, "mortified", None).unwrap();
        assert_eq!(r.lemma, "mortify");
        assert_eq!(r.inflected_from.as_deref(), Some("mortified"));
        assert!(r.forms.iter().any(|f| f == "mortifying"));
        assert_eq!(r.matches.len(), 1);
        assert_eq!(r.matches[0].dict_id, "builtin");
        assert_eq!(r.matches[0].gloss_zh.as_deref(), Some("使难堪；羞辱；克制"));

        assert_eq!(mgr.lookup_dictionary(&db, "went", None).unwrap().lemma, "go");
        assert_eq!(mgr.lookup_dictionary(&db, "children", None).unwrap().lemma, "child");
        assert_eq!(mgr.lookup_dictionary(&db, "better", None).unwrap().lemma, "good");

        // Suffix fallback (-ied -> -y, -ies -> -y, -ed, -ing, -es)
        let studied = mgr.lookup_dictionary(&db, "studied", None).unwrap();
        assert_eq!(studied.lemma, "study");
        assert_eq!(studied.inflected_from.as_deref(), Some("studied"));
        assert_eq!(mgr.lookup_dictionary(&db, "studies", None).unwrap().lemma, "study");
        assert_eq!(mgr.lookup_dictionary(&db, "walking", None).unwrap().lemma, "walk");
        assert_eq!(mgr.lookup_dictionary(&db, "boxes", None).unwrap().lemma, "box");

        // Homograph: `left` is both an independent lemma AND past tense of `leave`
        let left = mgr.lookup_dictionary(&db, "left", None).unwrap();
        assert_eq!(left.lemma, "left");
        assert_eq!(left.inflected_from, None);
        assert!(
            left.alternate_lemmas
                .iter()
                .any(|a| a.lemma == "leave" && a.relation == "past tense"),
            "expected leave in alternate_lemmas: {:?}",
            left.alternate_lemmas
        );
    }

    #[test]
    fn looks_up_chinese_simplified_and_traditional() {
        let (_dir, db, mgr) = setup_manager(true);

        let simp = mgr.lookup_dictionary(&db, "潜移默化", None).unwrap();
        assert_eq!(simp.lang, "zh");
        assert_eq!(simp.lemma, "潜移默化");
        assert_eq!(simp.matches.len(), 1);
        assert_eq!(simp.matches[0].pronunciation.as_deref(), Some("qián yí mò huà"));
        assert_eq!(
            simp.matches[0].gloss_en.as_deref(),
            Some("subtle, imperceptible influence")
        );

        let trad = mgr.lookup_dictionary(&db, "潛移默化", None).unwrap();
        assert_eq!(trad.lang, "zh");
        assert_eq!(trad.lemma, "潜移默化");
        assert_eq!(trad.inflected_from.as_deref(), Some("潛移默化"));
        assert_eq!(trad.matches.len(), 1);
    }

    #[test]
    fn imports_and_queries_stardict_plain_dictzip_and_priority_ordering() {
        let (dir, db, mgr) = setup_manager(true);

        let sd_plain_dir = dir.path().join("sd-plain");
        fs::create_dir_all(&sd_plain_dir).unwrap();
        let ifo1 = create_stardict_dir(
            &sd_plain_dir,
            "Custom Plain",
            "m",
            &[("mortify", "Custom plain definition of mortify.")],
            false,
        );
        let d1 = mgr.import_dictionary(&db, &ifo1).unwrap();
        assert_eq!(d1.format, "stardict");
        assert_eq!(d1.name, "Custom Plain");

        let sd_dz_dir = dir.path().join("sd-dz");
        fs::create_dir_all(&sd_dz_dir).unwrap();
        let ifo2 = create_stardict_dir(
            &sd_dz_dir,
            "Custom HTML DZ",
            "h",
            &[(
                "mortify",
                r#"<div style="color:red"><script>evil()</script><p><b>DZ</b> sense</p></div>"#,
            )],
            true,
        );
        let d2 = mgr.import_dictionary(&db, &ifo2).unwrap();

        // Default order: builtin first, then imported in append order
        let res = mgr.lookup_dictionary(&db, "mortified", None).unwrap();
        assert_eq!(res.lemma, "mortify");
        assert_eq!(res.matches.len(), 3);
        assert_eq!(res.matches[0].dict_id, "builtin");
        assert_eq!(res.matches[1].dict_id, d1.id);
        assert_eq!(res.matches[2].dict_id, d2.id);
        let dz_html = res.matches[2].html.as_deref().unwrap();
        assert!(!dz_html.contains("script"));
        assert!(!dz_html.contains("style="));
        assert!(dz_html.contains("<b>DZ</b> sense"));

        // Reorder d2 above builtin and disable builtin: lemmatization must STILL run!
        mgr.update_dictionaries_config(
            &db,
            vec![
                DictionaryConfigItem {
                    id: d2.id.clone(),
                    name: None,
                    format: None,
                    size_bytes: None,
                    entry_count: None,
                    enabled: true,
                },
                DictionaryConfigItem {
                    id: BUILTIN_DICT_ID.to_string(),
                    name: None,
                    format: None,
                    size_bytes: None,
                    entry_count: None,
                    enabled: false,
                },
                DictionaryConfigItem {
                    id: d1.id.clone(),
                    name: None,
                    format: None,
                    size_bytes: None,
                    entry_count: None,
                    enabled: true,
                },
            ],
        )
        .unwrap();

        let reordered = mgr.lookup_dictionary(&db, "mortified", None).unwrap();
        assert_eq!(reordered.lemma, "mortify");
        assert_eq!(reordered.matches.len(), 2);
        assert_eq!(reordered.matches[0].dict_id, d2.id);
        assert_eq!(reordered.matches[1].dict_id, d1.id);

        // Removing builtin is rejected; removing imported deletes its folder
        assert!(mgr.remove_dictionary(&db, BUILTIN_DICT_ID).is_err());
        mgr.remove_dictionary(&db, &d1.id).unwrap();
        assert!(!dir.path().join("dictionaries").join(&d1.id).exists());
    }

    #[test]
    fn imports_mdict_v1_v2_and_rejects_v3_and_encrypted() {
        let (dir, db, mgr) = setup_manager(true);

        let v2_path = dir.path().join("oxford-v2.mdx");
        build_synthetic_mdx(
            &v2_path,
            "2.0",
            "0",
            "Oxford Test v2",
            &[
                ("mortify", r#"<p style="color:#000">Oxford <b>mortify</b> sense</p><img src="x.png">"#),
                ("mortified", "@@@LINK=mortify"),
            ],
        );
        let d_v2 = mgr.import_dictionary(&db, &v2_path).unwrap();
        assert_eq!(d_v2.format, "mdx");
        assert_eq!(d_v2.name, "Oxford Test v2");

        let v1_path = dir.path().join("legacy-v1.mdx");
        build_synthetic_mdx(
            &v1_path,
            "1.2",
            "No",
            "Legacy v1.2",
            &[("ephemeral", "<div>Short-lived</div>")],
        );
        let d_v1 = mgr.import_dictionary(&db, &v1_path).unwrap();
        assert_eq!(d_v1.format, "mdx");

        let hit = mgr.lookup_dictionary(&db, "mortify", None).unwrap();
        let ox = hit.matches.iter().find(|m| m.dict_id == d_v2.id).unwrap();
        let html = ox.html.as_deref().unwrap();
        assert!(html.contains("Oxford <b>mortify</b> sense"));
        assert!(!html.contains("<img"));
        assert!(!html.contains("style="));

        let hit_v1 = mgr.lookup_dictionary(&db, "ephemeral", None).unwrap();
        let leg = hit_v1.matches.iter().find(|m| m.dict_id == d_v1.id).unwrap();
        assert_eq!(leg.html.as_deref(), Some("<div>Short-lived</div>"));

        // Reject MDict v3.0 DRM and Encrypted="1"
        let v3_path = dir.path().join("drm-v3.mdx");
        build_synthetic_mdx(&v3_path, "3.0", "0", "DRM v3", &[]);
        let err_v3 = mgr.import_dictionary(&db, &v3_path).unwrap_err();
        assert!(err_v3.to_string().contains("v3.0"), "{err_v3}");

        let enc_path = dir.path().join("enc-v2.mdx");
        build_synthetic_mdx(&enc_path, "2.0", "1", "Encrypted", &[]);
        let err_enc = mgr.import_dictionary(&db, &enc_path).unwrap_err();
        assert!(err_enc.to_string().contains("Encrypted"), "{err_enc}");
    }

    #[test]
    fn degrades_gracefully_when_builtin_dict_is_absent() {
        let (_dir, db, mgr) = setup_manager(false);
        let dicts = mgr.list_dictionaries(&db).unwrap();
        assert_eq!(dicts.len(), 1);
        assert_eq!(dicts[0].id, "builtin");
        assert_eq!(dicts[0].entry_count, 0);

        let res = mgr.lookup_dictionary(&db, "mortified", None).unwrap();
        assert_eq!(res.lemma, "mortified");
        assert!(res.matches.is_empty());
    }

    #[test]
    fn suffix_fallback_query_plan_uses_forms_index() {
        let dict = BuiltinDict::open(&fixture_dict_path()).unwrap();
        let plan = dict.suffix_fallback_query_plan().join(" | ");
        assert!(
            plan.contains("idx_forms_form_lang") || plan.contains("PRIMARY KEY (form=? AND lang=?)"),
            "expected suffix fallback query to use indexed forms(form, lang) lookup, got: {plan}"
        );
    }

    #[test]
    fn participial_adjective_resolves_to_base_verb_while_preserving_left_and_saw() {
        let dir = TempDir::new().unwrap();
        let custom_db = dir.path().join("dict-participle.db");
        fs::copy(fixture_dict_path(), &custom_db).unwrap();

        // Add a standalone `mortified` participial adjective entry mirroring upstream Kaikki
        let conn = rusqlite::Connection::open(&custom_db).unwrap();
        conn.execute(
            "INSERT INTO entries(id, lang, lemma, pron, senses_json, gloss_en, gloss_zh)
             VALUES (999, 'en', 'mortified', '/ˈmɔːrtɪfaɪd/', '[{\"pos\":\"adj.\",\"defs\":[\"Acutely embarrassed.\"]}]', NULL, '窘迫的')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO forms(form, lang, entry_id, is_lemma, relation)
             VALUES ('mortified', 'en', 999, 1, 'participial adjective')",
            [],
        )
        .unwrap();
        drop(conn);

        let db = Db::init(dir.path()).unwrap();
        let mgr = DictionaryManager::new(Some(custom_db), dir.path().join("dictionaries"));

        // With lemmatization enabled, `mortified` resolves to `mortify` (not self-looping)
        let res = mgr.lookup_dictionary(&db, "mortified", None).unwrap();
        assert_eq!(res.lemma, "mortify");
        assert_eq!(res.inflected_from.as_deref(), Some("mortified"));
        assert!(
            !res.alternate_lemmas
                .iter()
                .any(|a| a.lemma.eq_ignore_ascii_case("mortified")),
            "unexpected self-loop alternate: {:?}",
            res.alternate_lemmas
        );

        // Independent homographs `left` and `saw` stay primary with verb alternates
        let left = mgr.lookup_dictionary(&db, "left", None).unwrap();
        assert_eq!(left.lemma, "left");
        assert!(left.alternate_lemmas.iter().any(|a| a.lemma == "leave"));

        let saw = mgr.lookup_dictionary(&db, "saw", None).unwrap();
        assert_eq!(saw.lemma, "saw");
        assert!(saw.alternate_lemmas.iter().any(|a| a.lemma == "see"));
    }

    #[test]
    fn remove_rejects_invalid_or_unregistered_ids_and_stale_reorder_preserves_new_imports() {
        let (dir, db, mgr) = setup_manager(true);

        let sd1 = dir.path().join("sd1");
        fs::create_dir_all(&sd1).unwrap();
        let ifo1 = create_stardict_dir(&sd1, "First Dict", "m", &[("mortify", "First sense")], false);
        let d1 = mgr.import_dictionary(&db, &ifo1).unwrap();

        let sd2 = dir.path().join("sd2");
        fs::create_dir_all(&sd2).unwrap();
        let ifo2 = create_stardict_dir(&sd2, "Second Dict", "m", &[("mortify", "Second sense")], false);
        let d2 = mgr.import_dictionary(&db, &ifo2).unwrap();

        // Invalid & alias IDs must error and leave all imported dirs intact
        for bad in [
            "",
            ".",
            "..",
            "../dictionaries",
            "dict-not-a-uuid",
            &format!("dict-{}", uuid::Uuid::new_v4()), // valid format but unregistered
        ] {
            assert!(mgr.remove_dictionary(&db, bad).is_err(), "expected error for {bad:?}");
        }
        assert!(dir.path().join("dictionaries").join(&d1.id).exists());
        assert!(dir.path().join("dictionaries").join(&d2.id).exists());

        // Stale reorder omitting d2 must preserve d2 instead of dropping/orphaning it
        let updated = mgr
            .update_dictionaries_config(
                &db,
                vec![
                    DictionaryConfigItem {
                        id: d1.id.clone(),
                        name: None,
                        format: None,
                        size_bytes: None,
                        entry_count: None,
                        enabled: true,
                    },
                    DictionaryConfigItem {
                        id: BUILTIN_DICT_ID.to_string(),
                        name: None,
                        format: None,
                        size_bytes: None,
                        entry_count: None,
                        enabled: true,
                    },
                ],
            )
            .unwrap();
        let ids: Vec<&str> = updated.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, vec![d1.id.as_str(), BUILTIN_DICT_ID, d2.id.as_str()]);
        assert!(dir.path().join("dictionaries").join(&d2.id).exists());
    }

    #[test]
    fn rejects_corrupt_dictionaries_and_isolates_broken_source_during_lookup() {
        let (dir, db, mgr) = setup_manager(true);

        // 1. Corrupt MDict with huge declared key_block_info size past EOF must return Err, never panic/OOM
        let bad_mdx = dir.path().join("corrupt.mdx");
        let hdr_xml = r#"<Dictionary GeneratedByEngineVersion="2.0" Encrypted="0" Encoding="UTF-8" Title="Bad"/>"#;
        let mut raw = Vec::new();
        let mut utf16 = Vec::new();
        for u in hdr_xml.encode_utf16() {
            utf16.extend_from_slice(&u.to_le_bytes());
        }
        utf16.extend_from_slice(&[0, 0]);
        raw.extend_from_slice(&(utf16.len() as u32).to_be_bytes());
        raw.extend_from_slice(&utf16);
        raw.extend_from_slice(&[0u8; 4]);
        // 40-byte v2 key header declaring huge key_block_info_size = 0x7FFF_FFFF
        raw.extend_from_slice(&1u64.to_be_bytes());
        raw.extend_from_slice(&1u64.to_be_bytes());
        raw.extend_from_slice(&100u64.to_be_bytes());
        raw.extend_from_slice(&0x7FFF_FFFFu64.to_be_bytes());
        raw.extend_from_slice(&100u64.to_be_bytes());
        raw.extend_from_slice(&[0u8; 4]);
        fs::write(&bad_mdx, raw).unwrap();
        assert!(mgr.import_dictionary(&db, &bad_mdx).is_err());

        // 2. Corrupt StarDict whose .idx points past end of .dict must be rejected on import
        let bad_sd = dir.path().join("bad-sd");
        fs::create_dir_all(&bad_sd).unwrap();
        let mut bad_idx = Vec::new();
        bad_idx.extend_from_slice(b"mortify\0");
        bad_idx.extend_from_slice(&500u32.to_be_bytes()); // offset 500 > 5 byte dict!
        bad_idx.extend_from_slice(&10u32.to_be_bytes());
        fs::write(
            bad_sd.join("bad.ifo"),
            "StarDict's dict ifo file\nversion=2.4.2\nwordcount=1\nidxfilesize=16\nbookname=Bad\nsametypesequence=m\n",
        )
        .unwrap();
        fs::write(bad_sd.join("bad.idx"), bad_idx).unwrap();
        fs::write(bad_sd.join("bad.dict"), b"short").unwrap();
        assert!(mgr.import_dictionary(&db, &bad_sd.join("bad.ifo")).is_err());

        // 3. Valid imported dictionary that later gets corrupted on disk must NOT break built-in lookup
        let good_sd = dir.path().join("good-sd");
        fs::create_dir_all(&good_sd).unwrap();
        let ifo = create_stardict_dir(&good_sd, "Breakable", "m", &[("mortify", "Original sense")], false);
        let imported = mgr.import_dictionary(&db, &ifo).unwrap();
        // Truncate its data.dict to simulate on-disk corruption
        fs::write(dir.path().join("dictionaries").join(&imported.id).join("data.dict"), b"").unwrap();

        let res = mgr.lookup_dictionary(&db, "mortified", None).unwrap();
        assert_eq!(res.lemma, "mortify");
        assert_eq!(res.matches.len(), 1);
        assert_eq!(res.matches[0].dict_id, BUILTIN_DICT_ID);
    }
}
