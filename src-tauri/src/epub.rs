use epub::doc::EpubDoc;
use std::fs;
use std::path::Path;

use crate::error::{AppError, AppResult};

pub struct EpubMetadata {
    pub title: String,
    pub author: String,
    pub description: Option<String>,
    pub cover_path: Option<String>,
}

pub fn extract_metadata(epub_path: &Path, covers_dir: &Path, book_id: &str) -> AppResult<EpubMetadata> {
    let mut doc = EpubDoc::new(epub_path).map_err(|e| AppError::Epub(e.to_string()))?;

    let title = doc
        .mdata("title")
        .map(|m| m.value.clone())
        .unwrap_or_else(|| "Untitled".to_string());

    let author = doc
        .mdata("creator")
        .map(|m| m.value.clone())
        .unwrap_or_else(|| "Unknown Author".to_string());

    let description = doc.mdata("description").map(|m| m.value.clone());

    let cover_path = extract_cover(&mut doc, covers_dir, book_id);

    Ok(EpubMetadata {
        title,
        author,
        description,
        cover_path,
    })
}

fn extract_cover(doc: &mut EpubDoc<std::io::BufReader<std::fs::File>>, covers_dir: &Path, book_id: &str) -> Option<String> {
    let (data, mime) = resolve_cover_resource(doc)?;

    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/gif" => "gif",
        _ => "jpg",
    };

    let cover_filename = format!("{}.{}", book_id, ext);
    let cover_path = covers_dir.join(&cover_filename);

    fs::write(&cover_path, &data).ok()?;

    // Return relative path for DB storage
    Some(format!("covers/{}", cover_filename))
}

/// Resolve the cover image bytes + mime, walking through fallback
/// strategies. The `epub` crate's `get_cover()` only handles the
/// EPUB3 `properties="cover-image"` form, so books that declare a
/// `version="3.0"` package but use the legacy EPUB2 `<meta
/// name="cover" content="<id>"/>` pointer (common in older trade
/// publishing pipelines) fall through to `None`. We re-implement the
/// EPUB2 fallback here, then try a couple of conventional ids.
fn resolve_cover_resource(
    doc: &mut EpubDoc<std::io::BufReader<std::fs::File>>,
) -> Option<(Vec<u8>, String)> {
    if let Some(found) = doc.get_cover() {
        return Some(found);
    }

    // EPUB2-style: `<meta name="cover" content="<manifest-id>"/>`.
    // The crate parses this into a metadata item with property
    // "cover" whose value is the manifest id.
    if let Some(id) = doc.mdata("cover").map(|m| m.value.clone()) {
        if let Some(resource) = doc.get_resource(&id).filter(is_image_resource) {
            return Some(resource);
        }
    }

    // Conventional ids used by various publisher toolchains when
    // neither the EPUB3 property nor the EPUB2 meta hint is present.
    // Filter on the resource's mime type — `id="cover"` in particular
    // commonly points at `cover.xhtml` (the cover *page*) rather than
    // the cover image, and writing XHTML bytes to `<book_id>.jpg`
    // would render as a broken image in the library.
    for id in ["cover-image", "cover", "ci"] {
        if let Some(resource) = doc.get_resource(id).filter(is_image_resource) {
            return Some(resource);
        }
    }

    None
}

fn is_image_resource(resource: &(Vec<u8>, String)) -> bool {
    resource.1.starts_with("image/")
}

pub fn count_chapters(epub_path: &Path) -> AppResult<usize> {
    let doc = EpubDoc::new(epub_path).map_err(|e| AppError::Epub(e.to_string()))?;
    Ok(doc.get_num_chapters())
}
