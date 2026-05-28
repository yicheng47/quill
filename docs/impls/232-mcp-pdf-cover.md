# 232 — Backend-only PDF cover extraction (pdfium-render)

Issue: https://github.com/yicheng47/quill/issues/232

## Problem

`quill mcp` runs as a stdio subprocess outside the Tauri runtime (`src-tauri/src/lib.rs:150`) — no WebKit, no pdf.js. The frontend's lazy PDF cover renderer (`src/utils/pdfMetadata.ts`, driven by `backfillMissingCovers` in `src/hooks/useBooks.ts`) is unreachable from MCP imports. Result: every MCP-imported PDF lands with `cover_data = NULL` and stays uncovered until the user opens the desktop app.

Discovered while bulk-importing 156 magazine PDFs via MCP — all 156 came back with `has_cover: false`.

The existing frontend PDF import path also drags real costs:

- Two-step stage/commit dance (`stage_pdf_import` → `extractPdfMetadata` → `commit_pdf_import`) exists only so pdf.js can fetch the file via `tauri://localhost`. There is no metadata-review dialog between stage and commit — no UX value.
- `src/utils/pdfMetadata.ts` is 220 lines, half of which is workarounds for WebKit's `_createCDNWrapper` worker stall (issue #222).
- A backfill loop runs on every app launch to fix PDFs imported via MCP / older versions / failed pdf.js extractions.

## Approach

**Render page 1 of every PDF to a JPEG in Rust via `pdfium-render`, on the single `import_book` code path.** UI imports, MCP imports, and EPUB imports all go through one shape. No image-extraction heuristic, no "works for magazines, fails for text PDFs" trade-off — pdfium renders every valid PDF.

`pdfium-render` wraps Google's PDFium (BSD-3, same engine lineage as pdf.js). The dylib (~6MB per platform) is bundled with the app and loaded at runtime.

## Dependencies

`src-tauri/Cargo.toml`:

```toml
pdfium-render = "0.9"
image = { version = "0.25", default-features = false, features = ["jpeg"] }
```

Latest stable is `0.9.1` (May 2026). Verify the call-site names (`PdfRenderConfig`, `set_target_width`, `bind_to_library`, `pdfium_platform_library_name`, `load_pdf_from_file`) against the 0.9 docs at impl time — minor crates sometimes shuffle API surface.

`image` is a transitive of `pdfium-render` but we use it directly for JPEG encoding, so declare it explicitly.

## PDFium binary distribution

### Source

`https://github.com/bblanchon/pdfium-binaries` — prebuilt PDFium dylibs, MIT/BSD-3.
Per-platform archive names:
- `pdfium-mac-arm64.tgz` → `lib/libpdfium.dylib`
- `pdfium-mac-x64.tgz` → `lib/libpdfium.dylib`
- `pdfium-win-x64.tgz` → `bin/pdfium.dll`

Pin a specific release tag (`chromium/7857` as of impl) — never `latest` — so reproducible builds. **Note:** pdfium-render 0.9 expects a fairly recent PDFium ABI; older tags (`6996`, earlier 2025) miss symbols like `FPDF_StructElement_GetExpansion` and fail to bind.

### Layout in repo

```
src-tauri/
  binaries/
    macos-aarch64/libpdfium.dylib   # downloaded by CI, gitignored
    macos-x86_64/libpdfium.dylib
    windows-x86_64/pdfium.dll
    README.md                         # checked in: explains the download
  .gitignore                          # ignore libpdfium.dylib, pdfium.dll
```

A `src-tauri/build.rs` (already exists for Tauri) gains a step that, in dev/CI, downloads the right archive for the current build target if `binaries/<target>/<lib>` is missing. Pseudocode:

```rust
// In src-tauri/build.rs
fn ensure_pdfium() {
    let target = std::env::var("TARGET").unwrap();
    let (archive, lib_name, subdir) = match target.as_str() {
        "aarch64-apple-darwin" => ("pdfium-mac-arm64.tgz", "libpdfium.dylib", "macos-aarch64"),
        "x86_64-apple-darwin"  => ("pdfium-mac-x64.tgz",   "libpdfium.dylib", "macos-x86_64"),
        "x86_64-pc-windows-msvc" => ("pdfium-win-x64.tgz", "pdfium.dll",      "windows-x86_64"),
        _ => return,
    };
    let dest = Path::new("binaries").join(subdir).join(lib_name);
    if dest.exists() { return }
    // curl https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/6996/<archive>
    // extract <lib_name> to <dest>
}
```

This keeps `cargo build` working as the single command for new clones and CI alike — no extra GitHub Actions step needed.

### Bundling into the installer

`src-tauri/tauri.conf.json` — add per-platform paths so the dylib/dll ships inside the bundle alongside the executable:

```jsonc
"bundle": {
  "resources": {
    // resolved at bundle time per target; we drop the right one in alongside the binary
    "binaries/macos-aarch64/libpdfium.dylib": "libpdfium.dylib",
    "binaries/macos-x86_64/libpdfium.dylib": "libpdfium.dylib",
    "binaries/windows-x86_64/pdfium.dll": "pdfium.dll"
  }
}
```

Tauri's resource resolver picks the file matching the build target. The shipped binary ends up in `Contents/Resources/` (macOS) or alongside `quill.exe` (Windows). Verify the exact key syntax against Tauri 2 docs at impl time — the `bundle.resources` value can be either `string[]` or `{ src: dst }` map; the map form is what we want.

### Code-signing (macOS)

The existing release.yml signs the `.app` recursively. PDFium's dylib needs `--options runtime` and `--force` flags to re-sign — Tauri's bundler already does this for resources. **Action item during impl:** sanity-check `codesign -dv` on the bundled dylib after a CI build.

## Runtime path resolution

A single helper in `src-tauri/src/pdfium.rs` (new file):

```rust
use std::path::PathBuf;
use std::sync::OnceLock;
use pdfium_render::prelude::*;

static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

/// Returns a process-wide `Pdfium` instance. Initialized lazily on first
/// import; same handle reused for every subsequent PDF. Works both inside
/// the Tauri app and inside the `quill mcp` subprocess — both share the
/// same executable directory layout.
pub fn pdfium() -> Result<&'static Pdfium, &'static str> {
    PDFIUM.get_or_init(|| {
        let path = locate_pdfium_lib().ok_or("could not locate pdfium dylib")?;
        let bindings = Pdfium::bind_to_library(&path)
            .map_err(|e| format!("Pdfium::bind_to_library({path:?}): {e}"))?;
        Ok(Pdfium::new(bindings))
    }).as_ref().map_err(|s| s.as_str())
}

fn locate_pdfium_lib() -> Option<PathBuf> {
    let lib_name = Pdfium::pdfium_platform_library_name();  // e.g. "libpdfium.dylib"
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;

    // Try, in order:
    //   1. <exe_dir>/<lib>                                 ← Windows installer, dev `cargo run`
    //   2. <exe_dir>/../Resources/<lib>                    ← macOS .app bundle
    //   3. <repo>/src-tauri/binaries/<target>/<lib>        ← dev fallback (cargo test)
    let candidates = [
        exe_dir.join(&lib_name),
        exe_dir.join("../Resources").join(&lib_name),
        // dev fallback handled by build.rs setting OUT_DIR / a probe env var
    ];
    candidates.into_iter().find(|p| p.exists())
}
```

For `cargo test` we set an env var in `build.rs` pointing to the downloaded dev binary and `locate_pdfium_lib` also probes `env!("PDFIUM_DEV_LIB_PATH")` if defined.

## Implementation: `src-tauri/src/commands/books.rs`

### 1. New: `render_pdf_cover`

```rust
use std::io::Cursor;
use image::ImageFormat;
use pdfium_render::prelude::*;

/// Render page 1 to a JPEG suitable for storage in `books.cover_data`.
/// Returns `None` if the PDF is encrypted, corrupt, has no pages, or
/// pdfium itself fails to load — the import still succeeds without a cover.
fn render_pdf_cover(path: &std::path::Path) -> Option<Vec<u8>> {
    let pdfium = crate::pdfium::pdfium().ok()?;
    let doc = pdfium.load_pdf_from_file(path, None).ok()?;
    let page = doc.pages().first().ok()?;
    let bitmap = page
        .render_with_config(
            &PdfRenderConfig::new()
                .set_target_width(800)
                .render_form_data(false)
                .render_annotations(false),
        )
        .ok()?;
    let mut buf = Vec::new();
    bitmap
        .as_image()
        .into_rgb8()
        .write_to(&mut Cursor::new(&mut buf), ImageFormat::Jpeg)
        .ok()?;
    Some(buf)
}
```

Tunables:
- `target_width: 800` — covers display at ~180–300px @ 2–3x DPI. 800 gives one resize headroom.
- JPEG quality: `image` crate default (75). Good enough; downscale/quality knobs can come later if DB bloat shows up.
- `render_annotations / render_form_data: false` — form-field placeholder text shouldn't appear on covers.

### 2. Refactor `extract_pdf_metadata`

Same idea as before — take a loaded `lopdf::Document` so we can share one load between metadata + (in case we later want non-rendering image extraction). Actually, with pdfium handling rendering, the two paths are independent. **Keep `extract_pdf_metadata` as-is** (lopdf for the Info dictionary is cheap and proven). pdfium also has metadata access but it's a heavier API for the same result.

### 3. Rewrite `do_import_pdf`

```rust
pub(crate) fn do_import_pdf(file_path: &str, db: &Db, sync: &SyncWriter) -> AppResult<Book> {
    let data_dir = db.data_dir.lock().map_err(|e| AppError::Other(e.to_string()))?.clone();
    let books_dir = data_dir.join("books");
    fs::create_dir_all(&books_dir)?;

    let book_id = uuid::Uuid::new_v4().to_string();
    let src = std::path::Path::new(file_path);

    let (title, author, pages) = extract_pdf_metadata(src);
    let cover_bytes = render_pdf_cover(src);

    let filename = book_filename(&title, &book_id, "pdf");
    let dest = books_dir.join(&filename);
    fs::copy(src, &dest)?;

    let now = chrono::Utc::now().timestamp_millis();
    let rel_file_path = format!("books/{}", filename);
    let cover_data_b64 = cover_bytes.as_deref().map(cover_blob_to_data_uri);

    let book = Book {
        id: book_id,
        title,
        author,
        description: None,
        cover_path: None,
        file_path: rel_file_path,
        format: "pdf".to_string(),
        genre: None,
        pages: Some(pages),
        status: "unread".to_string(),
        progress: 0,
        current_cfi: None,
        created_at: now,
        updated_at: now,
        available: true,
        cover_data: cover_data_b64,
    };

    do_insert_book(&book, cover_bytes.as_deref(), db, sync, now)?;
    log::info!("import_book: complete id={} title={:?} format=pdf cover={}",
        book.id, book.title, cover_bytes.is_some());
    Ok(book)
}
```

`do_insert_book` already calls `sync.queue_cover_write` when bytes are present, so MCP-imported covers sync to peers automatically.

### 4. Delete obsolete commands

From `src-tauri/src/commands/books.rs`:
- `stage_pdf_import` (and `StagedPdf` struct)
- `commit_pdf_import`
- `cancel_pdf_import`
- `save_book_cover`
- `mark_cover_unavailable`
- `list_books_needing_covers` (and `CoverBackfillEntry` struct)

From `src-tauri/src/lib.rs` (the `invoke_handler` list around line 587):
- `commands::books::save_book_cover`
- `commands::books::mark_cover_unavailable`
- `commands::books::list_books_needing_covers`
- `commands::books::stage_pdf_import`
- `commands::books::commit_pdf_import`
- `commands::books::cancel_pdf_import`

Also register the new `pdfium` module in `src-tauri/src/lib.rs` (`mod pdfium;`).

## Implementation: frontend

### 1. Collapse PDF import to one call

`src/hooks/useBooks.ts` — replace `importFile` (lines 94-100) and delete `importPdfStaged` (102-123):

```typescript
async function importFile(filePath: string): Promise<Book> {
  return invoke<Book>("import_book", { filePath });
}
```

### 2. Delete backfill machinery

`src/hooks/useBooks.ts` — delete `CoverBackfillEntry`, `BACKFILL_BATCH_SIZE`, `BACKFILL_DELAY_MS`, `backfillRunning`, `backfillMissingCovers` (lines 127-174).

`src/pages/Home.tsx` — remove the `backfillMissingCovers` import (line 16) and its call (line 159, plus the comment/gating logic around it).

### 3. Delete `src/utils/pdfMetadata.ts` entirely

Verify nothing else imports from it once `useBooks.ts` is updated: `grep -r "pdfMetadata" src/`.

Keep `/public/foliate-js/vendor/pdfjs/` — still used by the reader for PDF rendering via foliate-js.

## Tests

### `src-tauri/src/commands/books.rs` `mod tests`

1. **`render_pdf_cover_renders_page_one`** — write a small known PDF fixture to a tempdir (a 1-page PDF generated via `lopdf` with a thin colored rectangle). Call `render_pdf_cover`. Assert returned bytes start with `\xFF\xD8\xFF` (JPEG magic) and decode to a non-zero-size image via the `image` crate.
2. **`render_pdf_cover_returns_none_for_corrupt_pdf`** — write `b"not a pdf"` to a tempfile. Assert `None`.
3. **`render_pdf_cover_returns_none_for_missing_file`** — pass a nonexistent path. Assert `None`.
4. **`do_import_pdf_populates_cover_data`** — write the fixture from test 1, call `do_import_pdf`, query the inserted row's `cover_data`. Assert non-null, JPEG magic, decodes cleanly.

Tests need PDFium available. The dev fallback path in `locate_pdfium_lib` handles this; `build.rs` ensures it's downloaded before `cargo test`.

### Manual smoke after build

- Import a magazine PDF via UI → cover renders immediately.
- Import a text-heavy PDF via UI → cover renders (page 1 as image).
- Import an encrypted PDF → no cover, no error in log other than the rendering-failed line.
- Import via MCP `add_book` → `has_cover: true` in tool response.

## Risks & verification

- **macOS signing of bundled dylib.** Verify `codesign -dv --verbose=4 /path/to/Quill.app/Contents/Resources/libpdfium.dylib` after CI build. If notarization complains, switch from `bundle.resources` to `bundle.macOS.frameworks` so it lands in `Contents/Frameworks/` (the canonical location).
- **Universal binary on macOS.** Release builds arm64 and x86_64 separately and produces a universal `.app` via `lipo` — the dylib must match. Easiest: ship two separate `.app`s and let the updater pick; or `lipo` the two dylibs into one universal `libpdfium.dylib`. Cross-check what the current release.yml does for the Rust binary itself.
- **Bundle size.** Installer grows ~6MB. Today's installer is ~15MB → ~21MB. Acceptable.
- **Cold-start latency on first import.** ~50–150ms to load the dylib + symbol resolution. Amortized across all subsequent imports via the `OnceLock`.

## Out of scope

- **Removing pdf.js from the reader.** Still needed by foliate-js for in-reader PDF display. Separate decision, separate change.
- **Cover downscaling / quality tuning.** Magazine JPEGs at 800px are ~50–150KB. Acceptable for a few hundred books. Revisit if DB bloat shows up.
- **Static-linking PDFium.** `pdfium-render` supports it but requires building PDFium ourselves — much harder than dynamic loading. Not worth it for a 6MB savings.
- **Linux build.** Not currently shipped (release.yml is macOS + Windows only). If/when Linux is added, the same build.rs flow extends to `pdfium-linux-x64.tgz`.
- **XMP metadata parsing.** pdfium's `FPDF_GetMetaText` only exposes the PDF Info dictionary. The old frontend pdf.js path additionally preferred XMP `dc:title` / `dc:creator` / `dc:description` from the catalog `/Metadata` stream. We deliberately don't replicate that: every modern PDF authoring tool (Acrobat, InDesign, Word/LibreOffice export, LaTeX+xmpincl) writes BOTH Info and XMP with matching values; XMP-only PDFs are dominated by PDF/A archival and PDF/X print-prep files, which aren't typical reading material. Those fall back to filename-derived title + "Unknown Author" + null description. Revisit if a real-world bug surfaces — a proper fix needs catalog object parsing, not a byte-scan heuristic.
