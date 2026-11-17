import fs from "node:fs";
import path from "node:path";

export function findRepoRoot(startDirs: string[]): string {
  for (const start of startDirs) {
    let dir = path.resolve(start);
    for (let i = 0; i < 6; i++) {
      if (
        fs.existsSync(path.join(dir, "Cargo.toml")) &&
        fs.existsSync(path.join(dir, "package.json"))
      ) {
        return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return process.cwd();
}

export interface McpBinaryOptions {
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  execPath?: string;
  resourcesPath?: string;
  cargoTargetDir?: string;
}

export function resolveMcpBinaryPath(repoRoot: string, opts: McpBinaryOptions): string {
  const platform = opts.platform ?? process.platform;
  const exe = platform === "win32" ? "quill-mcp.exe" : "quill-mcp";

  if (opts.isPackaged) {
    const candidates = [
      opts.resourcesPath ? path.join(opts.resourcesPath, exe) : "",
      opts.execPath ? path.join(path.dirname(opts.execPath), exe) : "",
    ].filter((c) => c.length > 0);
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
    throw new Error(
      `Packaged quill-mcp binary missing (checked ${candidates.join(", ") || "none"})`,
    );
  }

  // Dev mode must never fall back to target/release/quill-mcp: release builds
  // use the production bundle identifier and read/write production app data.
  const targetDir = opts.cargoTargetDir
    ? path.resolve(opts.cargoTargetDir)
    : path.join(repoRoot, "target");
  const debugBin = path.join(targetDir, "debug", exe);
  if (!fs.existsSync(debugBin)) {
    throw new Error(
      `Development quill-mcp binary not found at ${debugBin}. Run \`cargo build -p quill-mcp\` before launching dev.`,
    );
  }
  return debugBin;
}

export function resolvePdfiumPath(
  repoRoot: string,
  opts: { isPackaged: boolean; platform?: NodeJS.Platform; resourcesPath?: string },
): string | undefined {
  const platform = opts.platform ?? process.platform;
  const sub =
    platform === "darwin"
      ? path.join("macos", "libpdfium.dylib")
      : platform === "win32"
        ? path.join("windows", "pdfium.dll")
        : path.join("linux", "libpdfium.so");

  const candidates = opts.isPackaged
    ? [opts.resourcesPath ? path.join(opts.resourcesPath, path.basename(sub)) : ""].filter(
        Boolean,
      )
    : [path.join(repoRoot, "crates/quill-core/binaries", sub)];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}
