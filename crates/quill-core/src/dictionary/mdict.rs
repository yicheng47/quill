//! Unencrypted MDict (`.mdx`) v1.2 and v2.0 importer and fast indexed reader.
//!
//! Supports UTF-8, UTF-16LE, GBK/GB18030, and Big5 encodings; uncompressed,
//! zlib, and LZO1X blocks; v2.0 header key-block-info obfuscation (`Encrypted="2"`);
//! and `@@@LINK=` redirects. Encrypted/DRM dictionaries (`Encrypted="1"/"3"/"Yes"`,
//! `RegisterBy`, or engine version `>= 3.0`) are rejected with a clear error.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use flate2::read::ZlibDecoder;
use rusqlite::{params, Connection, OpenFlags};

use super::sanitize::sanitize_dictionary_html;
use super::{DictionaryMatch, ImportedDictMeta};
use crate::error::{AppError, AppResult};

const UNSUPPORTED_DRM_ERROR: &str =
    "Encrypted or MDict v3.0 DRM dictionaries are not supported. Only unencrypted MDict v1.2 and v2.0 (.mdx) files can be imported.";

struct MdxHeader {
    version: f32,
    encrypt_mode: u8, // 0 = none, 2 = v2.0 key-info fast decrypt
    encoding: String,
    title: String,
}

struct KeyEntry {
    record_offset: u64,
    key_text: String,
}

struct RecordBlockMeta {
    file_offset: u64,
    comp_size: u64,
    decomp_size: u64,
    decomp_start: u64,
}

pub(crate) fn import_mdict(source_path: &Path, dest_dir: &Path) -> AppResult<ImportedDictMeta> {
    let mut file = File::open(source_path)?;
    let fallback_title = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("MDict Dictionary")
        .to_string();

    let header = parse_mdx_header(&mut file, &fallback_title)?;
    let number_width: usize = if header.version >= 2.0 { 8 } else { 4 };

    // Key section header
    let key_header_size = if header.version >= 2.0 { 40 } else { 16 };
    let mut key_hdr_buf = vec![0u8; key_header_size];
    file.read_exact(&mut key_hdr_buf)
        .map_err(|e| AppError::Other(format!("Truncated MDict key header: {e}")))?;

    let num_key_blocks = read_uint(&key_hdr_buf, 0, number_width);
    let _num_entries = read_uint(&key_hdr_buf, number_width, number_width);
    let (key_block_info_size, key_blocks_size) = if header.version >= 2.0 {
        let mut _checksum = [0u8; 4];
        file.read_exact(&mut _checksum)?;
        (
            read_uint(&key_hdr_buf, 24, 8),
            read_uint(&key_hdr_buf, 32, 8),
        )
    } else {
        (
            read_uint(&key_hdr_buf, 8, 4),
            read_uint(&key_hdr_buf, 12, 4),
        )
    };

    let mut key_block_info_raw = vec![0u8; key_block_info_size as usize];
    file.read_exact(&mut key_block_info_raw)
        .map_err(|e| AppError::Other(format!("Truncated MDict key block info: {e}")))?;

    let key_block_info_bytes = if header.version >= 2.0 {
        if key_block_info_raw.len() < 8 {
            return Err(AppError::Other("Invalid MDict v2.0 key block info".into()));
        }
        if header.encrypt_mode == 2 {
            let mut key_seed = [0u8; 8];
            key_seed[..4].copy_from_slice(&key_block_info_raw[4..8]);
            key_seed[4..8].copy_from_slice(&[0x95, 0x36, 0x00, 0x00]);
            let key = ripemd128(&key_seed);
            mdx_fast_decrypt(&mut key_block_info_raw[8..], &key);
        }
        decompress_mdx_block(&key_block_info_raw)?
    } else {
        key_block_info_raw
    };

    let key_block_specs = parse_key_block_info(
        &key_block_info_bytes,
        num_key_blocks as usize,
        header.version,
        &header.encoding,
    )?;

    let mut key_blocks_buf = vec![0u8; key_blocks_size as usize];
    file.read_exact(&mut key_blocks_buf)
        .map_err(|e| AppError::Other(format!("Truncated MDict key blocks: {e}")))?;

    let keys = parse_key_blocks(&key_blocks_buf, &key_block_specs, header.version, &header.encoding)?;
    if keys.is_empty() {
        return Err(AppError::Other("MDict dictionary contains no entries".into()));
    }

    // Record section header
    let mut rec_hdr_buf = vec![0u8; number_width * 4];
    file.read_exact(&mut rec_hdr_buf)
        .map_err(|e| AppError::Other(format!("Truncated MDict record header: {e}")))?;
    let num_rec_blocks = read_uint(&rec_hdr_buf, 0, number_width) as usize;
    let _rec_num_entries = read_uint(&rec_hdr_buf, number_width, number_width);
    let rec_block_info_size = read_uint(&rec_hdr_buf, number_width * 2, number_width) as usize;
    let _rec_blocks_size = read_uint(&rec_hdr_buf, number_width * 3, number_width);

    let mut rec_info_buf = vec![0u8; rec_block_info_size];
    file.read_exact(&mut rec_info_buf)
        .map_err(|e| AppError::Other(format!("Truncated MDict record block info: {e}")))?;

    let record_blocks_start = file.stream_position()?;
    let mut record_blocks = Vec::with_capacity(num_rec_blocks);
    let mut file_cursor = record_blocks_start;
    let mut decomp_cursor = 0u64;
    let mut info_pos = 0usize;
    for _ in 0..num_rec_blocks {
        if info_pos + number_width * 2 > rec_info_buf.len() {
            return Err(AppError::Other("Corrupt MDict record block table".into()));
        }
        let comp_size = read_uint(&rec_info_buf, info_pos, number_width);
        let decomp_size = read_uint(&rec_info_buf, info_pos + number_width, number_width);
        info_pos += number_width * 2;
        record_blocks.push(RecordBlockMeta {
            file_offset: file_cursor,
            comp_size,
            decomp_size,
            decomp_start: decomp_cursor,
        });
        file_cursor += comp_size;
        decomp_cursor += decomp_size;
    }
    let total_decomp_size = decomp_cursor;

    fs::create_dir_all(dest_dir)?;
    fs::copy(source_path, dest_dir.join("data.mdx"))?;

    let entry_count = keys.len() as u64;
    let index_path = dest_dir.join("index.db");
    let mut conn = Connection::open(&index_path)?;
    conn.execute_batch(
        "PRAGMA journal_mode = OFF;
         PRAGMA synchronous = OFF;
         CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
         CREATE TABLE record_blocks (
             id INTEGER PRIMARY KEY,
             file_offset INTEGER NOT NULL,
             comp_size INTEGER NOT NULL,
             decomp_size INTEGER NOT NULL,
             decomp_start INTEGER NOT NULL
         );
         CREATE TABLE entries (
             key TEXT NOT NULL,
             headword TEXT NOT NULL,
             record_offset INTEGER NOT NULL,
             record_len INTEGER NOT NULL
         );",
    )?;

    let tx = conn.transaction()?;
    {
        let mut mstmt = tx.prepare("INSERT INTO meta(key, value) VALUES (?1, ?2)")?;
        mstmt.execute(params!["format", "mdx"])?;
        mstmt.execute(params!["title", header.title])?;
        mstmt.execute(params!["encoding", header.encoding])?;
        mstmt.execute(params!["version", format!("{:.1}", header.version)])?;
        mstmt.execute(params!["entry_count", entry_count.to_string()])?;
    }
    {
        let mut bstmt = tx.prepare(
            "INSERT INTO record_blocks(id, file_offset, comp_size, decomp_size, decomp_start)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for (idx, rb) in record_blocks.iter().enumerate() {
            bstmt.execute(params![
                idx as i64,
                rb.file_offset as i64,
                rb.comp_size as i64,
                rb.decomp_size as i64,
                rb.decomp_start as i64,
            ])?;
        }
    }
    {
        let mut estmt = tx.prepare(
            "INSERT INTO entries(key, headword, record_offset, record_len) VALUES (?1, ?2, ?3, ?4)",
        )?;
        for i in 0..keys.len() {
            let start = keys[i].record_offset;
            let end = if i + 1 < keys.len() {
                keys[i + 1].record_offset
            } else {
                total_decomp_size
            };
            let len = end.saturating_sub(start);
            let k = keys[i].key_text.trim().to_lowercase();
            if !k.is_empty() {
                estmt.execute(params![k, keys[i].key_text, start as i64, len as i64])?;
            }
        }
    }
    tx.execute("CREATE INDEX idx_entries_key ON entries(key);", [])?;
    tx.execute(
        "CREATE INDEX idx_record_blocks_decomp ON record_blocks(decomp_start);",
        [],
    )?;
    tx.commit()?;
    drop(conn);

    let size_bytes = super::dir_size_bytes(dest_dir);
    Ok(ImportedDictMeta {
        name: header.title,
        format: "mdx".to_string(),
        size_bytes,
        entry_count,
    })
}

pub fn query_mdict(
    dict_dir: &Path,
    dict_id: &str,
    dict_name: &str,
    term: &str,
) -> AppResult<Option<DictionaryMatch>> {
    let index_path = dict_dir.join("index.db");
    let data_path = dict_dir.join("data.mdx");
    if !index_path.exists() || !data_path.exists() {
        return Ok(None);
    }

    let conn = Connection::open_with_flags(
        &index_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let encoding: String = conn
        .query_row("SELECT value FROM meta WHERE key = 'encoding'", [], |r| r.get(0))
        .unwrap_or_else(|_| "UTF-8".to_string());

    let raw_html = lookup_mdx_following_links(&conn, &data_path, &encoding, term, 0)?;
    let Some(raw) = raw_html else {
        return Ok(None);
    };
    let clean = sanitize_dictionary_html(&raw);
    if clean.is_empty() {
        return Ok(None);
    }

    Ok(Some(DictionaryMatch {
        dict_id: dict_id.to_string(),
        dict_name: dict_name.to_string(),
        format: "mdx".to_string(),
        pronunciation: None,
        senses: None,
        html: Some(clean),
        plain_text: None,
        gloss_en: None,
        gloss_zh: None,
    }))
}

fn lookup_mdx_following_links(
    conn: &Connection,
    data_path: &Path,
    encoding: &str,
    term: &str,
    depth: u8,
) -> AppResult<Option<String>> {
    if depth > 3 {
        return Ok(None);
    }
    let key = term.trim().to_lowercase();
    if key.is_empty() {
        return Ok(None);
    }

    let mut stmt = conn.prepare(
        "SELECT record_offset, record_len FROM entries WHERE key = ?1 LIMIT 3",
    )?;
    let hits: Vec<(u64, u64)> = stmt
        .query_map(params![key], |r| {
            let off: i64 = r.get(0)?;
            let len: i64 = r.get(1)?;
            Ok((off.max(0) as u64, len.max(0) as u64))
        })?
        .collect::<Result<Vec<_>, _>>()?;

    if hits.is_empty() {
        return Ok(None);
    }

    let mut parts = Vec::new();
    for (offset, len) in hits {
        let bytes = read_record_bytes(conn, data_path, offset, len)?;
        let decoded = decode_mdx_string(&bytes, encoding);
        let trimmed = decoded.trim_end_matches('\0').trim();
        if let Some(target) = trimmed.strip_prefix("@@@LINK=") {
            let link_target = target.trim();
            if !link_target.is_empty() && !link_target.eq_ignore_ascii_case(term) {
                if let Some(linked) =
                    lookup_mdx_following_links(conn, data_path, encoding, link_target, depth + 1)?
                {
                    parts.push(linked);
                }
            }
        } else if !trimmed.is_empty() {
            parts.push(trimmed.to_string());
        }
    }

    if parts.is_empty() {
        Ok(None)
    } else {
        Ok(Some(parts.join("<hr>")))
    }
}

fn read_record_bytes(
    conn: &Connection,
    data_path: &Path,
    record_offset: u64,
    record_len: u64,
) -> AppResult<Vec<u8>> {
    if record_len == 0 {
        return Ok(Vec::new());
    }
    let record_end = record_offset.saturating_add(record_len);

    // Find the first block covering record_offset
    let first_block_id: i64 = conn.query_row(
        "SELECT id FROM record_blocks WHERE decomp_start <= ?1 ORDER BY decomp_start DESC LIMIT 1",
        params![record_offset as i64],
        |r| r.get(0),
    )?;

    let mut stmt = conn.prepare(
        "SELECT file_offset, comp_size, decomp_size, decomp_start
         FROM record_blocks
         WHERE id >= ?1 AND decomp_start < ?2
         ORDER BY id ASC",
    )?;
    let blocks: Vec<RecordBlockMeta> = stmt
        .query_map(params![first_block_id, record_end as i64], |r| {
            Ok(RecordBlockMeta {
                file_offset: r.get::<_, i64>(0)?.max(0) as u64,
                comp_size: r.get::<_, i64>(1)?.max(0) as u64,
                decomp_size: r.get::<_, i64>(2)?.max(0) as u64,
                decomp_start: r.get::<_, i64>(3)?.max(0) as u64,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut file = File::open(data_path)?;
    let mut out = Vec::with_capacity(record_len as usize);

    for block in blocks {
        file.seek(SeekFrom::Start(block.file_offset))?;
        let mut comp_buf = vec![0u8; block.comp_size as usize];
        file.read_exact(&mut comp_buf)?;
        let decomp = decompress_mdx_block(&comp_buf)?;

        let slice_start = record_offset.saturating_sub(block.decomp_start) as usize;
        let slice_end = (record_end.saturating_sub(block.decomp_start) as usize).min(decomp.len());
        if slice_start < slice_end {
            out.extend_from_slice(&decomp[slice_start..slice_end]);
        }
    }
    Ok(out)
}

fn parse_mdx_header(file: &mut File, fallback_title: &str) -> AppResult<MdxHeader> {
    let mut len_buf = [0u8; 4];
    file.read_exact(&mut len_buf)
        .map_err(|e| AppError::Other(format!("Failed reading MDict header length: {e}")))?;
    let header_bytes_size = u32::from_be_bytes(len_buf) as usize;
    if header_bytes_size == 0 || header_bytes_size > 2 * 1024 * 1024 {
        return Err(AppError::Other(
            "Invalid MDict (.mdx) file header size".into(),
        ));
    }

    let mut header_bytes = vec![0u8; header_bytes_size];
    file.read_exact(&mut header_bytes)?;
    let mut _adler = [0u8; 4];
    file.read_exact(&mut _adler)?;

    let header_xml = decode_utf16le(&header_bytes);
    if !header_xml.contains("<Dictionary") {
        return Err(AppError::Other(
            "Invalid MDict (.mdx) header XML".into(),
        ));
    }

    let attrs = parse_xml_attributes(&header_xml);
    let version = attrs
        .get("generatedbyengineversion")
        .and_then(|v| v.trim().parse::<f32>().ok())
        .unwrap_or(2.0);
    if version >= 3.0 {
        return Err(AppError::Other(UNSUPPORTED_DRM_ERROR.into()));
    }

    if attrs
        .get("registerby")
        .is_some_and(|v| !v.trim().is_empty())
    {
        return Err(AppError::Other(UNSUPPORTED_DRM_ERROR.into()));
    }

    let encrypted_raw = attrs
        .get("encrypted")
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let encrypt_mode = match encrypted_raw.as_str() {
        "" | "0" | "no" | "false" => 0,
        "2" => 2,
        _ => return Err(AppError::Other(UNSUPPORTED_DRM_ERROR.into())),
    };

    let encoding = attrs
        .get("encoding")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "UTF-8".to_string());

    let title = attrs
        .get("title")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s != "Title (No HTML code allowed)")
        .unwrap_or_else(|| fallback_title.to_string());

    Ok(MdxHeader {
        version,
        encrypt_mode,
        encoding,
        title,
    })
}

fn parse_xml_attributes(xml: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let bytes = xml.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        // Find attribute name
        while i < bytes.len() && !bytes[i].is_ascii_alphabetic() {
            i += 1;
        }
        let name_start = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
            i += 1;
        }
        let name = &xml[name_start..i];
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes.get(i) != Some(&b'=') {
            continue;
        }
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        let Some(&quote) = bytes.get(i).filter(|&&b| b == b'"' || b == b'\'') else {
            continue;
        };
        i += 1;
        let val_start = i;
        while i < bytes.len() && bytes[i] != quote {
            i += 1;
        }
        let val = xml[val_start..i]
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"");
        map.insert(name.to_ascii_lowercase(), val);
        if i < bytes.len() {
            i += 1;
        }
    }
    map
}

fn parse_key_block_info(
    data: &[u8],
    num_blocks: usize,
    version: f32,
    encoding: &str,
) -> AppResult<Vec<(u64, u64)>> {
    let is_v2 = version >= 2.0;
    let num_width = if is_v2 { 8 } else { 4 };
    let text_term = if is_utf16(encoding) { 2 } else { 1 };
    let mut pos = 0usize;
    let mut specs = Vec::with_capacity(num_blocks);

    for _ in 0..num_blocks {
        if pos + num_width > data.len() {
            return Err(AppError::Other("Truncated MDict key block info".into()));
        }
        let _entries_in_block = read_uint(data, pos, num_width);
        pos += num_width;

        // First key text
        let first_len = if is_v2 {
            let l = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
            pos += 2;
            (l + 1) * text_term
        } else {
            let l = data[pos] as usize;
            pos += 1;
            l * text_term
        };
        pos = pos.saturating_add(first_len);

        // Last key text
        if pos + (if is_v2 { 2 } else { 1 }) > data.len() {
            return Err(AppError::Other("Truncated MDict key block info (last key)".into()));
        }
        let last_len = if is_v2 {
            let l = u16::from_be_bytes([data[pos], data[pos + 1]]) as usize;
            pos += 2;
            (l + 1) * text_term
        } else {
            let l = data[pos] as usize;
            pos += 1;
            l * text_term
        };
        pos = pos.saturating_add(last_len);

        if pos + num_width * 2 > data.len() {
            return Err(AppError::Other("Truncated MDict key block info sizes".into()));
        }
        let comp_size = read_uint(data, pos, num_width);
        let decomp_size = read_uint(data, pos + num_width, num_width);
        pos += num_width * 2;
        specs.push((comp_size, decomp_size));
    }

    Ok(specs)
}

fn parse_key_blocks(
    buf: &[u8],
    specs: &[(u64, u64)],
    version: f32,
    encoding: &str,
) -> AppResult<Vec<KeyEntry>> {
    let num_width = if version >= 2.0 { 8 } else { 4 };
    let utf16 = is_utf16(encoding);
    let mut keys = Vec::new();
    let mut pos = 0usize;

    for &(comp_size, _decomp_size) in specs {
        let cs = comp_size as usize;
        if pos + cs > buf.len() {
            return Err(AppError::Other("Truncated MDict key block payload".into()));
        }
        let decomp = decompress_mdx_block(&buf[pos..pos + cs])?;
        pos += cs;

        let mut kpos = 0usize;
        while kpos + num_width < decomp.len() {
            let rec_offset = read_uint(&decomp, kpos, num_width);
            kpos += num_width;
            let text_start = kpos;
            if utf16 {
                while kpos + 1 < decomp.len() && !(decomp[kpos] == 0 && decomp[kpos + 1] == 0) {
                    kpos += 2;
                }
                let text = decode_mdx_string(&decomp[text_start..kpos], encoding);
                kpos = (kpos + 2).min(decomp.len());
                keys.push(KeyEntry {
                    record_offset: rec_offset,
                    key_text: text,
                });
            } else {
                while kpos < decomp.len() && decomp[kpos] != 0 {
                    kpos += 1;
                }
                let text = decode_mdx_string(&decomp[text_start..kpos], encoding);
                kpos = (kpos + 1).min(decomp.len());
                keys.push(KeyEntry {
                    record_offset: rec_offset,
                    key_text: text,
                });
            }
        }
    }

    Ok(keys)
}

fn decompress_mdx_block(block: &[u8]) -> AppResult<Vec<u8>> {
    if block.len() < 8 {
        return Err(AppError::Other("MDict block shorter than 8-byte header".into()));
    }
    let comp_type = u32::from_be_bytes([block[0], block[1], block[2], block[3]]);
    let payload = &block[8..];
    match comp_type {
        0x0000_0000 => Ok(payload.to_vec()),
        0x0100_0000 => lzo1x_decompress(payload),
        0x0200_0000 => {
            let mut decoder = ZlibDecoder::new(payload);
            let mut out = Vec::new();
            decoder
                .read_to_end(&mut out)
                .map_err(|e| AppError::Other(format!("MDict zlib decompress failed: {e}")))?;
            Ok(out)
        }
        other => Err(AppError::Other(format!(
            "Unsupported MDict block compression type: 0x{other:08x}"
        ))),
    }
}

fn read_uint(buf: &[u8], offset: usize, width: usize) -> u64 {
    if width == 8 {
        u64::from_be_bytes(buf[offset..offset + 8].try_into().unwrap())
    } else {
        u32::from_be_bytes(buf[offset..offset + 4].try_into().unwrap()) as u64
    }
}

fn is_utf16(encoding: &str) -> bool {
    let low = encoding.to_ascii_lowercase();
    low.contains("utf-16") || low.contains("utf16")
}

fn decode_utf16le(bytes: &[u8]) -> String {
    let u16s: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    String::from_utf16_lossy(&u16s)
        .trim_end_matches('\0')
        .to_string()
}

fn decode_mdx_string(bytes: &[u8], encoding: &str) -> String {
    let low = encoding.to_ascii_lowercase();
    if low.contains("utf-16") || low.contains("utf16") {
        return decode_utf16le(bytes);
    }
    if low.contains("gbk") || low.contains("gb2312") || low.contains("gb18030") {
        let (cow, _, _) = encoding_rs::GB18030.decode(bytes);
        return cow.into_owned();
    }
    if low.contains("big5") {
        let (cow, _, _) = encoding_rs::BIG5.decode(bytes);
        return cow.into_owned();
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn mdx_fast_decrypt(data: &mut [u8], key: &[u8]) {
    let mut prev: u8 = 0x36;
    for (i, b) in data.iter_mut().enumerate() {
        let orig = *b;
        let mut t = orig.rotate_left(4);
        t = t ^ prev ^ ((i & 0xFF) as u8) ^ key[i % key.len()];
        prev = orig;
        *b = t;
    }
}

/// Pure-Rust LZO1X decompressor for MDict `0x01000000` record/key blocks.
fn lzo1x_decompress(src: &[u8]) -> AppResult<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(src.len().saturating_mul(2));
    let mut ip = 0usize;
    let len = src.len();
    if len == 0 {
        return Ok(out);
    }

    let mut state: usize;

    let b0 = src[ip] as usize;
    if b0 > 17 {
        let t = b0 - 17;
        ip += 1;
        if t < 4 {
            copy_literals(src, &mut ip, &mut out, t)?;
            state = t;
        } else {
            copy_literals(src, &mut ip, &mut out, t)?;
            state = 4;
        }
    } else {
        state = 0;
    }

    while ip < len {
        let mut b = src[ip] as usize;
        ip += 1;

        if b < 16 {
            if state == 0 {
                if b == 0 {
                    while ip < len && src[ip] == 0 {
                        b += 255;
                        ip += 1;
                    }
                    if ip >= len {
                        return Err(AppError::Other("Truncated LZO1X literal run".into()));
                    }
                    b += 15 + src[ip] as usize;
                    ip += 1;
                }
                copy_literals(src, &mut ip, &mut out, b + 3)?;
                state = 4;
                continue;
            } else if state < 4 {
                let m_pos = out
                    .len()
                    .checked_sub(1 + (b >> 2) + ((read_byte(src, &mut ip)? as usize) << 2))
                    .ok_or_else(|| AppError::Other("Invalid LZO1X back-reference".into()))?;
                copy_match(&mut out, m_pos, 2)?;
                let lit = b & 3;
                copy_literals(src, &mut ip, &mut out, lit)?;
                state = lit;
                continue;
            } else {
                let m_pos = out
                    .len()
                    .checked_sub(2049 + (b >> 2) + ((read_byte(src, &mut ip)? as usize) << 2))
                    .ok_or_else(|| AppError::Other("Invalid LZO1X back-reference".into()))?;
                copy_match(&mut out, m_pos, 3)?;
                let lit = b & 3;
                copy_literals(src, &mut ip, &mut out, lit)?;
                state = lit;
                continue;
            }
        }

        let (m_pos, m_len, lit) = if b >= 64 {
            let dist = 1 + ((b >> 2) & 7) + ((read_byte(src, &mut ip)? as usize) << 3);
            let m_pos = out
                .len()
                .checked_sub(dist)
                .ok_or_else(|| AppError::Other("Invalid LZO1X M2 match".into()))?;
            (m_pos, (b >> 5) - 1 + 2, b & 3)
        } else if b >= 32 {
            let mut m_len = b & 31;
            if m_len == 0 {
                while ip < len && src[ip] == 0 {
                    m_len += 255;
                    ip += 1;
                }
                if ip >= len {
                    return Err(AppError::Other("Truncated LZO1X M3 length".into()));
                }
                m_len += 31 + src[ip] as usize;
                ip += 1;
            }
            let lo = read_byte(src, &mut ip)? as usize;
            let hi = read_byte(src, &mut ip)? as usize;
            let dist = 1 + (lo >> 2) + (hi << 6);
            let m_pos = out
                .len()
                .checked_sub(dist)
                .ok_or_else(|| AppError::Other("Invalid LZO1X M3 match".into()))?;
            (m_pos, m_len + 2, lo & 3)
        } else {
            // M4 (16..=31)
            let mut m_len = b & 7;
            if m_len == 0 {
                while ip < len && src[ip] == 0 {
                    m_len += 255;
                    ip += 1;
                }
                if ip >= len {
                    return Err(AppError::Other("Truncated LZO1X M4 length".into()));
                }
                m_len += 7 + src[ip] as usize;
                ip += 1;
            }
            let lo = read_byte(src, &mut ip)? as usize;
            let hi = read_byte(src, &mut ip)? as usize;
            let dist = ((b & 8) << 11) + (lo >> 2) + (hi << 6);
            if dist == 0 {
                // End-of-stream marker
                break;
            }
            let m_pos = out
                .len()
                .checked_sub(dist + 0x4000)
                .ok_or_else(|| AppError::Other("Invalid LZO1X M4 match".into()))?;
            (m_pos, m_len + 2, lo & 3)
        };

        copy_match(&mut out, m_pos, m_len)?;
        copy_literals(src, &mut ip, &mut out, lit)?;
        state = lit;
    }

    Ok(out)
}

fn read_byte(src: &[u8], ip: &mut usize) -> AppResult<u8> {
    if *ip >= src.len() {
        return Err(AppError::Other("Unexpected EOF in LZO1X stream".into()));
    }
    let b = src[*ip];
    *ip += 1;
    Ok(b)
}

fn copy_literals(src: &[u8], ip: &mut usize, out: &mut Vec<u8>, count: usize) -> AppResult<()> {
    if *ip + count > src.len() {
        return Err(AppError::Other("Truncated LZO1X literal bytes".into()));
    }
    out.extend_from_slice(&src[*ip..*ip + count]);
    *ip += count;
    Ok(())
}

fn copy_match(out: &mut Vec<u8>, start: usize, len: usize) -> AppResult<()> {
    if start >= out.len() {
        return Err(AppError::Other("Invalid LZO1X match offset".into()));
    }
    for i in 0..len {
        let byte = out[start + i];
        out.push(byte);
    }
    Ok(())
}

/// Pure-Rust RIPEMD-128 used strictly for MDict v2.0 `Encrypted="2"` key-block-info decoding.
fn ripemd128(data: &[u8]) -> [u8; 16] {
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let mut h0: u32 = 0x6745_2301;
    let mut h1: u32 = 0xEFCD_AB89;
    let mut h2: u32 = 0x98BA_DCFE;
    let mut h3: u32 = 0x1032_5476;

    const RL: [usize; 64] = [
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9,
        5, 2, 14, 11, 8, 3, 10, 14, 4, 9, 15, 8, 1, 2, 7, 0, 6, 13, 11, 5, 12, 1, 9, 11, 10, 0, 8,
        12, 4, 13, 3, 7, 15, 14, 5, 6, 2,
    ];
    const RR: [usize; 64] = [
        5, 14, 7, 0, 9, 2, 11, 4, 13, 6, 15, 8, 1, 10, 3, 12, 6, 11, 3, 7, 0, 13, 5, 10, 14, 15, 8,
        12, 4, 9, 1, 2, 15, 5, 1, 3, 7, 14, 6, 9, 11, 8, 12, 2, 10, 0, 4, 13, 8, 6, 4, 1, 3, 11,
        15, 0, 5, 12, 2, 13, 9, 7, 10, 14,
    ];
    const SL: [u32; 64] = [
        11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8, 7, 6, 8, 13, 11, 9, 7, 15, 7, 12,
        15, 9, 11, 7, 13, 12, 11, 13, 6, 7, 14, 9, 13, 15, 14, 8, 13, 6, 5, 12, 7, 5, 11, 12, 14,
        15, 14, 15, 9, 8, 9, 14, 5, 6, 8, 6, 5, 12,
    ];
    const SR: [u32; 64] = [
        8, 9, 9, 11, 13, 15, 15, 5, 7, 7, 8, 11, 14, 14, 12, 6, 9, 13, 15, 7, 12, 8, 9, 11, 7, 7,
        12, 7, 6, 15, 13, 11, 9, 7, 15, 11, 8, 6, 6, 14, 12, 13, 5, 14, 13, 13, 7, 5, 15, 5, 8, 11,
        14, 14, 6, 14, 6, 9, 12, 9, 12, 5, 15, 8,
    ];

    for chunk in msg.chunks_exact(64) {
        let mut x = [0u32; 16];
        for i in 0..16 {
            x[i] = u32::from_le_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
        }
        let (mut al, mut bl, mut cl, mut dl) = (h0, h1, h2, h3);
        let (mut ar, mut br, mut cr, mut dr) = (h0, h1, h2, h3);

        for j in 0..64 {
            let (fl, kl) = match j {
                0..=15 => (bl ^ cl ^ dl, 0x0000_0000u32),
                16..=31 => ((bl & cl) | (!bl & dl), 0x5A82_7999),
                32..=47 => ((bl | !cl) ^ dl, 0x6ED9_EBA1),
                _ => ((bl & dl) | (cl & !dl), 0x8F1B_BCDC),
            };
            let t = al
                .wrapping_add(fl)
                .wrapping_add(x[RL[j]])
                .wrapping_add(kl)
                .rotate_left(SL[j]);
            al = dl;
            dl = cl;
            cl = bl;
            bl = t;

            let (fr, kr) = match j {
                0..=15 => ((br & dr) | (cr & !dr), 0x50A2_8BE6u32),
                16..=31 => ((br | !cr) ^ dr, 0x5C4D_D124),
                32..=47 => ((br & cr) | (!br & dr), 0x6D70_3EF3),
                _ => (br ^ cr ^ dr, 0x0000_0000),
            };
            let t = ar
                .wrapping_add(fr)
                .wrapping_add(x[RR[j]])
                .wrapping_add(kr)
                .rotate_left(SR[j]);
            ar = dr;
            dr = cr;
            cr = br;
            br = t;
        }

        let t = h1.wrapping_add(cl).wrapping_add(dr);
        h1 = h2.wrapping_add(dl).wrapping_add(ar);
        h2 = h3.wrapping_add(al).wrapping_add(br);
        h3 = h0.wrapping_add(bl).wrapping_add(cr);
        h0 = t;
    }

    let mut out = [0u8; 16];
    out[0..4].copy_from_slice(&h0.to_le_bytes());
    out[4..8].copy_from_slice(&h1.to_le_bytes());
    out[8..12].copy_from_slice(&h2.to_le_bytes());
    out[12..16].copy_from_slice(&h3.to_le_bytes());
    out
}
