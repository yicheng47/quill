//! Process-wide PDFium binding.
//!
//! Both the Tauri app and the `quill mcp` stdio subprocess share the
//! same executable layout, so the same path-resolution logic works in
//! both contexts. The dylib is loaded lazily on first call to `pdfium()`
//! and reused for the lifetime of the process.

use std::path::PathBuf;
use std::sync::OnceLock;

use pdfium_render::prelude::*;

static PDFIUM: OnceLock<Result<Pdfium, String>> = OnceLock::new();

/// Returns a process-wide `Pdfium` instance, or an error string suitable
/// for logging. Callers use this for best-effort cover rendering — on
/// failure, fall back to no cover rather than failing the import.
pub fn pdfium() -> Result<&'static Pdfium, &'static str> {
    let result = PDFIUM.get_or_init(|| {
        let path = locate_pdfium_lib().ok_or_else(|| {
            "could not locate pdfium dylib next to executable or in bundle".to_string()
        })?;
        let bindings = Pdfium::bind_to_library(&path)
            .map_err(|e| format!("Pdfium::bind_to_library({}): {e}", path.display()))?;
        Ok(Pdfium::new(bindings))
    });
    result.as_ref().map_err(|s| s.as_str())
}

fn locate_pdfium_lib() -> Option<PathBuf> {
    let lib_name = Pdfium::pdfium_platform_library_name();

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            // 1. Alongside the executable. Windows installer, Linux, dev `cargo run`
            //    if the dylib was copied into target/.
            let candidate = exe_dir.join(&lib_name);
            if candidate.exists() {
                return Some(candidate);
            }
            // 2. macOS .app bundle: Contents/MacOS/quill → Contents/Resources/<lib>
            let bundle_resources = exe_dir.join("..").join("Resources").join(&lib_name);
            if bundle_resources.exists() {
                return Some(bundle_resources);
            }
            // 3. macOS .app bundle alternate: Contents/Frameworks/
            let bundle_frameworks = exe_dir.join("..").join("Frameworks").join(&lib_name);
            if bundle_frameworks.exists() {
                return Some(bundle_frameworks);
            }
        }
    }

    // 4. Dev fallback: build.rs emits PDFIUM_DEV_LIB_PATH pointing at the
    //    binary it downloaded into src-tauri/binaries/<target>/. This is
    //    what cargo test picks up.
    if let Some(dev_path) = option_env!("PDFIUM_DEV_LIB_PATH") {
        let p = PathBuf::from(dev_path);
        if p.exists() {
            return Some(p);
        }
    }

    None
}
