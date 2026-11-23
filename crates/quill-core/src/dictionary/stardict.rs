//! StarDict dictionary importer and fast indexed reader.
//!
//! Supports `.ifo` + `.idx`/`.idx.gz` + `.dict`/`.dict.dz` (+ optional `.syn`),
//! selected as a `.ifo` file, a folder containing `.ifo`, or a `.zip` archive.
//! Handles `sametypesequence` `m`, `h`, `g`, `x` (and per-record type bytes).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use flate2::read::{DeflateDecoder, GzDecoder};
use rusqlite::{params, Connection, OpenFlags};

use super::sanitize::{pango_to_html, sanitize_dictionary_html, xdxf_to_html};
use super::{DictionaryMatch, ImportedDictMeta};
use crate::error::{AppError, AppResult};

struct TempExtractGuard(PathBuf);

impl TempExtractGuard {
    fn create() -> AppResult<Self> {
        let dir = std::env::temp_dir().join(format!("quill-stardict-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempExtractGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct StarDictFiles {
    ifo_path: PathBuf,
    idx_path: PathBuf,
    dict_path: PathBuf,
    syn_path: Option<PathBuf>,
    _temp_extract: Option<TempExtractGuard>,
}

struct IfoMeta {
    bookname: String,
    idx_offset_bits: u32,
    same_type_sequence: String,
}

struct DictzipHeader {
    chunk_len: usize,
    chunk_offsets: Vec<(u64, u64)>, // (file_offset, compressed_len)
}

pub(crate) fn import_stardict(source_path: &Path, dest_dir: &Path) -> AppResult<ImportedDictMeta> {
    let files = locate_stardict_files(source_path)?;
    let ifo_text = fs::read_to_string(&files.ifo_path)
        .map_err(|e| AppError::Other(format!("Failed to read StarDict .ifo: {e}")))?;
    let ifo = parse_ifo(&ifo_text)?;

    let idx_bytes = read_plain_or_gz(&files.idx_path)?;
    let entries = parse_idx(&idx_bytes, ifo.idx_offset_bits)?;
    if entries.is_empty() {
        return Err(AppError::Other(
            "StarDict dictionary contains no index entries".into(),
        ));
    }

    let mut synonyms: Vec<(String, u64, u32)> = Vec::new();
    if let Some(ref syn_path) = files.syn_path {
        if let Ok(syn_bytes) = read_plain_or_gz(syn_path) {
            for (syn_word, orig_idx) in parse_syn(&syn_bytes) {
                if let Some((_, off, sz)) = entries.get(orig_idx as usize) {
                    synonyms.push((syn_word, *off, *sz));
                }
            }
        }
    }

    fs::create_dir_all(dest_dir)?;

    // Copy dict payload: preserve valid dictzip (.dict.dz with RA extra field) for
    // fast chunked random access, or store plain uncompressed data.dict.
    let is_dz_ext = files
        .dict_path
        .file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|n| n.to_ascii_lowercase().ends_with(".dz"));

    let (data_file_name, is_dictzip) = if is_dz_ext && parse_dictzip_header(&files.dict_path).is_ok() {
        fs::copy(&files.dict_path, dest_dir.join("data.dict.dz"))?;
        ("data.dict.dz", true)
    } else if is_dz_ext {
        // Plain gzip without dictzip RA chunks — inflate once at import time.
        let mut decoder = GzDecoder::new(File::open(&files.dict_path)?);
        let mut out = File::create(dest_dir.join("data.dict"))?;
        std::io::copy(&mut decoder, &mut out)?;
        ("data.dict", false)
    } else {
        fs::copy(&files.dict_path, dest_dir.join("data.dict"))?;
        ("data.dict", false)
    };

    let entry_count = entries.len() as u64;
    let index_path = dest_dir.join("index.db");
    let mut conn = Connection::open(&index_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = OFF;
         PRAGMA synchronous = OFF;
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE words (
             key TEXT NOT NULL,
             headword TEXT NOT NULL,
             offset INTEGER NOT NULL,
             size INTEGER NOT NULL
         );",
    )?;

    let tx = conn.transaction()?;
    {
        let mut mstmt = tx.prepare("INSERT INTO meta(key, value) VALUES (?1, ?2)")?;
        mstmt.execute(params!["format", "stardict"])?;
        mstmt.execute(params!["title", ifo.bookname])?;
        mstmt.execute(params!["sametypesequence", ifo.same_type_sequence])?;
        mstmt.execute(params!["data_file", data_file_name])?;
        mstmt.execute(params!["is_dictzip", if is_dictzip { "1" } else { "0" }])?;
        mstmt.execute(params!["entry_count", entry_count.to_string()])?;
    }
    {
        let mut wstmt =
            tx.prepare("INSERT INTO words(key, headword, offset, size) VALUES (?1, ?2, ?3, ?4)")?;
        for (word, offset, size) in &entries {
            let key = word.trim().to_lowercase();
            if !key.is_empty() {
                wstmt.execute(params![key, word, *offset as i64, *size as i64])?;
            }
        }
        for (syn, offset, size) in &synonyms {
            let key = syn.trim().to_lowercase();
            if !key.is_empty() {
                wstmt.execute(params![key, syn, *offset as i64, *size as i64])?;
            }
        }
    }
    tx.execute("CREATE INDEX idx_words_key ON words(key);", [])?;
    tx.commit()?;
    drop(conn);

    let size_bytes = super::dir_size_bytes(dest_dir);
    Ok(ImportedDictMeta {
        name: ifo.bookname,
        format: "stardict".to_string(),
        size_bytes,
        entry_count,
    })
}

pub fn query_stardict(
    dict_dir: &Path,
    dict_id: &str,
    dict_name: &str,
    term: &str,
) -> AppResult<Option<DictionaryMatch>> {
    let index_path = dict_dir.join("index.db");
    if !index_path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(
        &index_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    let key = term.trim().to_lowercase();
    if key.is_empty() {
        return Ok(None);
    }

    let mut stmt = conn.prepare("SELECT offset, size FROM words WHERE key = ?1 LIMIT 3")?;
    let hits: Vec<(u64, usize)> = stmt
        .query_map(params![key], |r| {
            let off: i64 = r.get(0)?;
            let sz: i64 = r.get(1)?;
            Ok((off.max(0) as u64, sz.max(0) as usize))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if hits.is_empty() {
        return Ok(None);
    }

    let get_meta = |k: &str| -> String {
        conn.query_row("SELECT value FROM meta WHERE key = ?1", params![k], |r| {
            r.get::<_, String>(0)
        })
        .unwrap_or_default()
    };
    let sts = get_meta("sametypesequence");
    let data_file = get_meta("data_file");
    let is_dictzip = get_meta("is_dictzip") == "1";
    let data_path = dict_dir.join(if data_file.is_empty() {
        "data.dict"
    } else {
        &data_file
    });

    let mut html_parts: Vec<String> = Vec::new();
    let mut text_parts: Vec<String> = Vec::new();
    let mut pronunciation: Option<String> = None;

    for (offset, size) in hits {
        let payload = if is_dictzip {
            read_dictzip_slice(&data_path, offset, size)?
        } else {
            read_plain_slice(&data_path, offset, size)?
        };
        decode_stardict_record(
            &payload,
            &sts,
            &mut html_parts,
            &mut text_parts,
            &mut pronunciation,
        );
    }

    if html_parts.is_empty() && text_parts.is_empty() {
        return Ok(None);
    }

    let (html, plain_text) = if !html_parts.is_empty() {
        let mut combined = html_parts.join("<hr>");
        if !text_parts.is_empty() {
            let escaped = sanitize_dictionary_html(&text_parts.join("<br>"));
            if !escaped.is_empty() {
                combined.push_str("<p>");
                combined.push_str(&escaped);
                combined.push_str("</p>");
            }
        }
        (Some(combined), None)
    } else {
        (None, Some(text_parts.join("\n\n")))
    };

    Ok(Some(DictionaryMatch {
        dict_id: dict_id.to_string(),
        dict_name: dict_name.to_string(),
        format: "stardict".to_string(),
        pronunciation,
        senses: None,
        html,
        plain_text,
        gloss_en: None,
        gloss_zh: None,
    }))
}

fn decode_stardict_record(
    payload: &[u8],
    same_type_sequence: &str,
    html_parts: &mut Vec<String>,
    text_parts: &mut Vec<String>,
    pronunciation: &mut Option<String>,
) {
    if !same_type_sequence.is_empty() {
        let types: Vec<u8> = same_type_sequence.bytes().collect();
        let mut pos = 0usize;
        for (idx, &ty) in types.iter().enumerate() {
            if pos >= payload.len() {
                break;
            }
            let is_last = idx + 1 == types.len();
            let slice = if ty.is_ascii_lowercase() {
                if is_last {
                    let s = &payload[pos..];
                    pos = payload.len();
                    s.strip_suffix(b"\0").unwrap_or(s)
                } else if let Some(nul) = payload[pos..].iter().position(|&b| b == 0) {
                    let s = &payload[pos..pos + nul];
                    pos += nul + 1;
                    s
                } else {
                    let s = &payload[pos..];
                    pos = payload.len();
                    s
                }
            } else if is_last {
                let s = &payload[pos..];
                pos = payload.len();
                s
            } else if pos + 4 <= payload.len() {
                let len = u32::from_be_bytes(payload[pos..pos + 4].try_into().unwrap()) as usize;
                pos += 4;
                let end = (pos + len).min(payload.len());
                let s = &payload[pos..end];
                pos = end;
                s
            } else {
                break;
            };
            push_typed_field(ty, slice, html_parts, text_parts, pronunciation);
        }
    } else {
        let mut pos = 0usize;
        while pos < payload.len() {
            let ty = payload[pos];
            pos += 1;
            if ty.is_ascii_lowercase() {
                let end = payload[pos..]
                    .iter()
                    .position(|&b| b == 0)
                    .map(|n| pos + n)
                    .unwrap_or(payload.len());
                let slice = &payload[pos..end];
                pos = (end + 1).min(payload.len());
                push_typed_field(ty, slice, html_parts, text_parts, pronunciation);
            } else if pos + 4 <= payload.len() {
                let len = u32::from_be_bytes(payload[pos..pos + 4].try_into().unwrap()) as usize;
                pos += 4;
                let end = (pos + len).min(payload.len());
                let slice = &payload[pos..end];
                pos = end;
                push_typed_field(ty, slice, html_parts, text_parts, pronunciation);
            } else {
                break;
            }
        }
    }
}

fn push_typed_field(
    ty: u8,
    slice: &[u8],
    html_parts: &mut Vec<String>,
    text_parts: &mut Vec<String>,
    pronunciation: &mut Option<String>,
) {
    let text = String::from_utf8_lossy(slice).trim().to_string();
    if text.is_empty() {
        return;
    }
    match ty {
        b'h' => {
            let clean = sanitize_dictionary_html(&text);
            if !clean.is_empty() {
                html_parts.push(clean);
            }
        }
        b'g' => {
            let clean = pango_to_html(&text);
            if !clean.is_empty() {
                html_parts.push(clean);
            }
        }
        b'x' => {
            let clean = xdxf_to_html(&text);
            if !clean.is_empty() {
                html_parts.push(clean);
            }
        }
        b't' | b'y' => {
            if pronunciation.is_none() {
                *pronunciation = Some(text);
            }
        }
        b'm' | b'l' => {
            text_parts.push(text);
        }
        _ => {}
    }
}

fn locate_stardict_files(source_path: &Path) -> AppResult<StarDictFiles> {
    if source_path.is_dir() {
        let ifo = find_ifo_in_dir(source_path)?;
        return resolve_siblings_from_ifo(ifo, None);
    }

    let ext = source_path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    if ext == "zip" {
        let tmp = TempExtractGuard::create()?;
        let file = File::open(source_path)?;
        let mut archive = zip::ZipArchive::new(file)
            .map_err(|e| AppError::Other(format!("Invalid StarDict .zip archive: {e}")))?;

        for i in 0..archive.len() {
            let mut entry = archive
                .by_index(i)
                .map_err(|e| AppError::Other(format!("Failed reading zip entry: {e}")))?;
            let Some(enclosed) = entry.enclosed_name().map(|p| p.to_path_buf()) else {
                continue;
            };
            let out_path = tmp.path().join(enclosed);
            if entry.is_dir() {
                fs::create_dir_all(&out_path)?;
            } else {
                if let Some(parent) = out_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut out_file = File::create(&out_path)?;
                std::io::copy(&mut entry, &mut out_file)?;
            }
        }
        let ifo = find_ifo_in_dir(tmp.path())?;
        return resolve_siblings_from_ifo(ifo, Some(tmp));
    }

    if ext == "ifo" {
        return resolve_siblings_from_ifo(source_path.to_path_buf(), None);
    }

    Err(AppError::Other(
        "Unsupported StarDict path: select a .ifo file, folder, or .zip archive".into(),
    ))
}

fn find_ifo_in_dir(dir: &Path) -> AppResult<PathBuf> {
    let mut subdirs = Vec::new();
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_file()
            && path
                .extension()
                .and_then(|s| s.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("ifo"))
        {
            return Ok(path);
        }
        if path.is_dir()
            && path
                .file_name()
                .and_then(|s| s.to_str())
                .is_some_and(|n| !n.starts_with('.') && n != "__MACOSX")
        {
            subdirs.push(path);
        }
    }
    for sub in subdirs {
        for entry in fs::read_dir(&sub)? {
            let path = entry?.path();
            if path.is_file()
                && path
                    .extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|e| e.eq_ignore_ascii_case("ifo"))
            {
                return Ok(path);
            }
        }
    }
    Err(AppError::Other(
        "No StarDict .ifo file found in the selected folder or archive".into(),
    ))
}

fn resolve_siblings_from_ifo(
    ifo_path: PathBuf,
    temp_extract: Option<TempExtractGuard>,
) -> AppResult<StarDictFiles> {
    let parent = ifo_path
        .parent()
        .ok_or_else(|| AppError::Other("Invalid .ifo path".into()))?;
    let stem = ifo_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| AppError::Other("Invalid .ifo filename".into()))?;

    let idx_path = [
        parent.join(format!("{stem}.idx")),
        parent.join(format!("{stem}.idx.gz")),
    ]
    .into_iter()
    .find(|p| p.exists())
    .ok_or_else(|| AppError::Other(format!("Missing StarDict .idx file for {stem}.ifo")))?;

    let dict_path = [
        parent.join(format!("{stem}.dict.dz")),
        parent.join(format!("{stem}.dict")),
    ]
    .into_iter()
    .find(|p| p.exists())
    .ok_or_else(|| {
        AppError::Other(format!("Missing StarDict .dict or .dict.dz file for {stem}.ifo"))
    })?;

    let syn_path = [
        parent.join(format!("{stem}.syn")),
        parent.join(format!("{stem}.syn.gz")),
    ]
    .into_iter()
    .find(|p| p.exists());

    Ok(StarDictFiles {
        ifo_path,
        idx_path,
        dict_path,
        syn_path,
        _temp_extract: temp_extract,
    })
}

fn parse_ifo(text: &str) -> AppResult<IfoMeta> {
    let cleaned = text.trim_start_matches('\u{FEFF}');
    let mut lines = cleaned.lines();
    let header = lines.next().unwrap_or("").trim();
    if !header.starts_with("StarDict's dict ifo file") {
        return Err(AppError::Other(
            "Invalid StarDict .ifo file header".into(),
        ));
    }
    let mut kv: HashMap<String, String> = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once('=') {
            kv.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let bookname = kv
        .get("bookname")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "StarDict Dictionary".to_string());
    let idx_offset_bits = kv
        .get("idxoffsetbits")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(32);
    if idx_offset_bits != 32 && idx_offset_bits != 64 {
        return Err(AppError::Other(format!(
            "Unsupported StarDict idxoffsetbits={idx_offset_bits}"
        )));
    }
    let same_type_sequence = kv.get("sametypesequence").cloned().unwrap_or_default();
    Ok(IfoMeta {
        bookname,
        idx_offset_bits,
        same_type_sequence,
    })
}

fn read_plain_or_gz(path: &Path) -> AppResult<Vec<u8>> {
    let mut raw = Vec::new();
    let is_gz = path
        .extension()
        .and_then(|s| s.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("gz"));
    if is_gz {
        let mut gz = GzDecoder::new(File::open(path)?);
        gz.read_to_end(&mut raw)?;
    } else {
        File::open(path)?.read_to_end(&mut raw)?;
    }
    Ok(raw)
}

fn parse_idx(bytes: &[u8], offset_bits: u32) -> AppResult<Vec<(String, u64, u32)>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    let off_len = if offset_bits == 64 { 8 } else { 4 };

    while pos < bytes.len() {
        let Some(nul) = bytes[pos..].iter().position(|&b| b == 0) else {
            break;
        };
        let word = String::from_utf8_lossy(&bytes[pos..pos + nul]).into_owned();
        pos += nul + 1;
        if pos + off_len + 4 > bytes.len() {
            break;
        }
        let offset = if off_len == 8 {
            u64::from_be_bytes(bytes[pos..pos + 8].try_into().unwrap())
        } else {
            u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap()) as u64
        };
        pos += off_len;
        let size = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap());
        pos += 4;
        out.push((word, offset, size));
    }
    Ok(out)
}

fn parse_syn(bytes: &[u8]) -> Vec<(String, u32)> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < bytes.len() {
        let Some(nul) = bytes[pos..].iter().position(|&b| b == 0) else {
            break;
        };
        let word = String::from_utf8_lossy(&bytes[pos..pos + nul]).into_owned();
        pos += nul + 1;
        if pos + 4 > bytes.len() {
            break;
        }
        let idx = u32::from_be_bytes(bytes[pos..pos + 4].try_into().unwrap());
        pos += 4;
        out.push((word, idx));
    }
    out
}

fn read_plain_slice(path: &Path, offset: u64, size: usize) -> AppResult<Vec<u8>> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0u8; size];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

fn parse_dictzip_header(path: &Path) -> AppResult<DictzipHeader> {
    let mut file = File::open(path)?;
    let mut hdr = [0u8; 10];
    file.read_exact(&mut hdr)?;
    if hdr[0] != 0x1F || hdr[1] != 0x8B || hdr[2] != 8 {
        return Err(AppError::Other("Not a gzip/dictzip stream".into()));
    }
    let flags = hdr[3];
    if (flags & 0x04) == 0 {
        return Err(AppError::Other("Gzip stream lacks dictzip FEXTRA header".into()));
    }

    let mut xlen_buf = [0u8; 2];
    file.read_exact(&mut xlen_buf)?;
    let xlen = u16::from_le_bytes(xlen_buf) as usize;
    let mut extra = vec![0u8; xlen];
    file.read_exact(&mut extra)?;

    let mut chunk_len: usize = 0;
    let mut comp_lens: Vec<u16> = Vec::new();
    let mut pos = 0usize;
    while pos + 4 <= extra.len() {
        let si1 = extra[pos];
        let si2 = extra[pos + 1];
        let slen = u16::from_le_bytes([extra[pos + 2], extra[pos + 3]]) as usize;
        pos += 4;
        if pos + slen > extra.len() {
            break;
        }
        if si1 == b'R' && si2 == b'A' && slen >= 6 {
            let ver = u16::from_le_bytes([extra[pos], extra[pos + 1]]);
            if ver == 1 {
                chunk_len = u16::from_le_bytes([extra[pos + 2], extra[pos + 3]]) as usize;
                let chcnt = u16::from_le_bytes([extra[pos + 4], extra[pos + 5]]) as usize;
                if 6 + chcnt * 2 <= slen {
                    comp_lens.reserve(chcnt);
                    for c in 0..chcnt {
                        let o = pos + 6 + c * 2;
                        comp_lens.push(u16::from_le_bytes([extra[o], extra[o + 1]]));
                    }
                }
            }
        }
        pos += slen;
    }

    if chunk_len == 0 || comp_lens.is_empty() {
        return Err(AppError::Other("Invalid dictzip RA subfield".into()));
    }

    // Skip optional FNAME, FCOMMENT, FHCRC
    if (flags & 0x08) != 0 {
        skip_cstring(&mut file)?;
    }
    if (flags & 0x10) != 0 {
        skip_cstring(&mut file)?;
    }
    if (flags & 0x02) != 0 {
        let mut crc = [0u8; 2];
        file.read_exact(&mut crc)?;
    }

    let mut cur_offset = file.stream_position()?;
    let mut chunk_offsets = Vec::with_capacity(comp_lens.len());
    for clen in comp_lens {
        let cl = clen as u64;
        chunk_offsets.push((cur_offset, cl));
        cur_offset += cl;
    }

    Ok(DictzipHeader {
        chunk_len,
        chunk_offsets,
    })
}

fn skip_cstring(file: &mut File) -> AppResult<()> {
    let mut b = [0u8; 1];
    loop {
        file.read_exact(&mut b)?;
        if b[0] == 0 {
            return Ok(());
        }
    }
}

fn read_dictzip_slice(path: &Path, offset: u64, size: usize) -> AppResult<Vec<u8>> {
    if size == 0 {
        return Ok(Vec::new());
    }
    let header = parse_dictzip_header(path)?;
    let start_chunk = (offset as usize) / header.chunk_len;
    let end_byte = (offset as usize).saturating_add(size);
    let end_chunk = (end_byte.saturating_sub(1)) / header.chunk_len;
    if end_chunk >= header.chunk_offsets.len() {
        return Err(AppError::Other("Dictzip offset out of range".into()));
    }

    let mut file = File::open(path)?;
    let mut decompressed = Vec::with_capacity((end_chunk - start_chunk + 1) * header.chunk_len);
    for idx in start_chunk..=end_chunk {
        let (file_off, comp_len) = header.chunk_offsets[idx];
        file.seek(SeekFrom::Start(file_off))?;
        let mut comp_buf = vec![0u8; comp_len as usize];
        file.read_exact(&mut comp_buf)?;
        let mut decoder = DeflateDecoder::new(&comp_buf[..]);
        decoder.read_to_end(&mut decompressed)?;
    }

    let local_start = (offset as usize) - start_chunk * header.chunk_len;
    let local_end = (local_start + size).min(decompressed.len());
    Ok(decompressed[local_start..local_end].to_vec())
}
