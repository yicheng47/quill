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
    let (data, mime) = doc.get_cover()?;

    let ext = match mime.as_str() {
        "image/png" => "png",
        "image/gif" => "gif",
        _ => "jpg",
    };

    let cover_filename = format!("{}.{}", book_id, ext);
    let cover_path = covers_dir.join(&cover_filename);

    fs::write(&cover_path, &data).ok()?;

    Some(cover_path.to_string_lossy().to_string())
}

pub fn count_chapters(epub_path: &Path) -> AppResult<usize> {
    let doc = EpubDoc::new(epub_path).map_err(|e| AppError::Epub(e.to_string()))?;
    Ok(doc.get_num_chapters())
}
