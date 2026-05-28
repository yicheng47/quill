use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const PDFIUM_VERSION: &str = "chromium/7857";

fn main() {
    // Must run before `tauri_build::build()` — Tauri validates that any
    // `bundle.macOS.frameworks` / `bundle.resources` paths exist at config
    // load time, and `tauri.<platform>.conf.json` overlays point at the
    // active-target binary `ensure_pdfium` publishes to `binaries/<os>/`.
    if let Err(e) = ensure_pdfium() {
        println!("cargo:warning=pdfium download failed: {e}");
        println!("cargo:warning=PDF cover rendering will fail at runtime until the dylib is present");
    }
    tauri_build::build();
}

fn ensure_pdfium() -> Result<(), String> {
    let target = env::var("TARGET").map_err(|e| e.to_string())?;
    let Some(spec) = pdfium_spec(&target) else {
        return Ok(());
    };

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").map_err(|e| e.to_string())?);
    let dest_dir = manifest_dir.join("binaries").join(spec.subdir);
    let dest = dest_dir.join(spec.lib_name);

    println!("cargo:rerun-if-changed={}", dest.display());
    if dest.exists() {
        publish_active_target(&manifest_dir, &dest, &spec)?;
        println!("cargo:rustc-env=PDFIUM_DEV_LIB_PATH={}", dest.display());
        return Ok(());
    }

    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let url = format!(
        "https://github.com/bblanchon/pdfium-binaries/releases/download/{PDFIUM_VERSION}/{}",
        spec.archive
    );
    println!("cargo:warning=downloading {url}");

    let tmp_archive = dest_dir.join(spec.archive);
    let curl = Command::new("curl")
        .args(["-fsSL", "-o"])
        .arg(&tmp_archive)
        .arg(&url)
        .status()
        .map_err(|e| format!("curl failed to launch: {e}"))?;
    if !curl.success() {
        return Err(format!("curl exited with {curl}"));
    }

    let tar = Command::new("tar")
        .arg("-xzf")
        .arg(&tmp_archive)
        .arg("-C")
        .arg(&dest_dir)
        .arg(spec.archive_member)
        .status()
        .map_err(|e| format!("tar failed to launch: {e}"))?;
    if !tar.success() {
        return Err(format!("tar exited with {tar}"));
    }

    let extracted = dest_dir.join(spec.archive_member);
    if extracted != dest {
        fs::rename(&extracted, &dest).map_err(|e| e.to_string())?;
        cleanup_empty_parents(&extracted, &dest_dir);
    }
    let _ = fs::remove_file(&tmp_archive);

    publish_active_target(&manifest_dir, &dest, &spec)?;
    println!("cargo:rustc-env=PDFIUM_DEV_LIB_PATH={}", dest.display());
    Ok(())
}

/// Copy the resolved per-target binary to a stable `binaries/<platform>/`
/// path so `tauri.<platform>.conf.json` can reference it without knowing
/// the build arch. macOS arm64 + x86_64 builds both publish to
/// `binaries/macos/libpdfium.dylib`; the file is the right architecture
/// for whichever target is currently being built.
fn publish_active_target(manifest_dir: &Path, src: &Path, spec: &PdfiumSpec) -> Result<(), String> {
    let platform = spec.subdir.split_once('-').map(|(p, _)| p).unwrap_or(spec.subdir);
    let active_dir = manifest_dir.join("binaries").join(platform);
    fs::create_dir_all(&active_dir).map_err(|e| e.to_string())?;
    let active = active_dir.join(spec.lib_name);
    if active.exists() {
        let _ = fs::remove_file(&active);
    }
    fs::copy(src, &active).map_err(|e| e.to_string())?;
    Ok(())
}

struct PdfiumSpec {
    archive: &'static str,
    archive_member: &'static str,
    subdir: &'static str,
    lib_name: &'static str,
}

fn pdfium_spec(target: &str) -> Option<PdfiumSpec> {
    match target {
        "aarch64-apple-darwin" => Some(PdfiumSpec {
            archive: "pdfium-mac-arm64.tgz",
            archive_member: "lib/libpdfium.dylib",
            subdir: "macos-aarch64",
            lib_name: "libpdfium.dylib",
        }),
        "x86_64-apple-darwin" => Some(PdfiumSpec {
            archive: "pdfium-mac-x64.tgz",
            archive_member: "lib/libpdfium.dylib",
            subdir: "macos-x86_64",
            lib_name: "libpdfium.dylib",
        }),
        "x86_64-pc-windows-msvc" => Some(PdfiumSpec {
            archive: "pdfium-win-x64.tgz",
            archive_member: "bin/pdfium.dll",
            subdir: "windows-x86_64",
            lib_name: "pdfium.dll",
        }),
        // Linux isn't a shipping target yet, but CI runs `cargo test --lib`
        // on ubuntu — the PDF cover tests need a dylib to bind against.
        "x86_64-unknown-linux-gnu" => Some(PdfiumSpec {
            archive: "pdfium-linux-x64.tgz",
            archive_member: "lib/libpdfium.so",
            subdir: "linux-x86_64",
            lib_name: "libpdfium.so",
        }),
        "aarch64-unknown-linux-gnu" => Some(PdfiumSpec {
            archive: "pdfium-linux-arm64.tgz",
            archive_member: "lib/libpdfium.so",
            subdir: "linux-aarch64",
            lib_name: "libpdfium.so",
        }),
        _ => None,
    }
}

fn cleanup_empty_parents(extracted: &Path, stop_at: &Path) {
    let mut cur = extracted.parent();
    while let Some(p) = cur {
        if p == stop_at {
            break;
        }
        if fs::remove_dir(p).is_err() {
            break;
        }
        cur = p.parent();
    }
}
