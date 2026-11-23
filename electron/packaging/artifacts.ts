import fs from "node:fs";
import path from "node:path";
import type { AfterPackContext } from "electron-builder";
import { Arch } from "electron-builder";
import { assertBinaryArch, type BinaryArch } from "../../scripts/binary-arch.mjs";

export const PROVISIONING_PROFILE_PATH = "build/embedded.provisionprofile";

export interface PackagingTargetSpec {
  platform: "darwin" | "win32";
  arch: "arm64" | "x64";
  rustTarget: string;
  pdfiumRelativePath: string;
  pdfiumDestName: string;
  mcpBinaryName: string;
  expectedBinaryArch: BinaryArch;
}

export interface NativeBundleSources {
  spec: PackagingTargetSpec;
  nodeAddon: string;
  mcpBinary: string;
  pdfiumLib: string;
  dictDb: string;
}

/**
 * Derive a strictly 1-to-3-component numeric macOS CFBundleVersion matching Apple's
 * documented Info.plist integer format (`major.minor.patch` or `YYYYMMDD.HHMM`).
 */
export function resolveMacBundleVersion(version: string): string {
  const nightly = /^\d+\.\d+\.\d+-nightly\.(\d{8})(\d{4})$/.exec(version);
  if (nightly) {
    return `${nightly[1]}.${nightly[2]}`;
  }
  const core = /^(\d+\.\d+\.\d+)/.exec(version);
  if (core) {
    return core[1];
  }
  throw new Error(`Unsupported version format for macOS CFBundleVersion: ${version}`);
}

export function hostRustTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  return null;
}

export function resolvePackagingTarget(
  electronPlatformName: string,
  arch: Arch | "arm64" | "x64",
  envRustTarget?: string,
): PackagingTargetSpec {
  const archName = typeof arch === "string" ? arch : Arch[arch];

  let spec: PackagingTargetSpec;
  if (electronPlatformName === "darwin" && archName === "arm64") {
    spec = {
      platform: "darwin",
      arch: "arm64",
      rustTarget: "aarch64-apple-darwin",
      pdfiumRelativePath: "crates/quill-core/binaries/macos-aarch64/libpdfium.dylib",
      pdfiumDestName: "libpdfium.dylib",
      mcpBinaryName: "quill-mcp",
      expectedBinaryArch: "arm64",
    };
  } else if (electronPlatformName === "darwin" && archName === "x64") {
    spec = {
      platform: "darwin",
      arch: "x64",
      rustTarget: "x86_64-apple-darwin",
      pdfiumRelativePath: "crates/quill-core/binaries/macos-x86_64/libpdfium.dylib",
      pdfiumDestName: "libpdfium.dylib",
      mcpBinaryName: "quill-mcp",
      expectedBinaryArch: "x64",
    };
  } else if (electronPlatformName === "win32" && archName === "x64") {
    spec = {
      platform: "win32",
      arch: "x64",
      rustTarget: "x86_64-pc-windows-msvc",
      pdfiumRelativePath: "crates/quill-core/binaries/windows-x86_64/pdfium.dll",
      pdfiumDestName: "pdfium.dll",
      mcpBinaryName: "quill-mcp.exe",
      expectedBinaryArch: "x64",
    };
  } else {
    throw new Error(`Unsupported packaging target: ${electronPlatformName}/${archName}`);
  }

  if (envRustTarget && envRustTarget !== spec.rustTarget) {
    throw new Error(
      `QUILL_RUST_TARGET (${envRustTarget}) does not match packaging target (${spec.rustTarget})`,
    );
  }

  return spec;
}

function firstExisting(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function resolveNativeBundleSources(
  projectDir: string,
  electronPlatformName: string,
  arch: Arch | "arm64" | "x64",
  options: {
    allowDebugFallback?: boolean;
    envRustTarget?: string;
    hostPlatform?: NodeJS.Platform;
    hostArch?: string;
    cargoTargetDir?: string;
  } = {},
): NativeBundleSources {
  const spec = resolvePackagingTarget(electronPlatformName, arch, options.envRustTarget);
  const cargoTargetRoot = options.cargoTargetDir
    ? path.resolve(options.cargoTargetDir)
    : path.join(projectDir, "target");
  const isHostTarget =
    spec.rustTarget === hostRustTarget(options.hostPlatform, options.hostArch);

  const nodeCandidates = [
    path.join(projectDir, "out", "native", spec.rustTarget, "index.node"),
    path.join(projectDir, "crates", "quill-node", "index.node"),
  ];
  const nodeAddon = firstExisting(nodeCandidates);
  if (!nodeAddon) {
    throw new Error(
      `Missing quill-node addon for ${spec.rustTarget} (checked ${nodeCandidates.join(", ")})`,
    );
  }
  assertBinaryArch(nodeAddon, spec.expectedBinaryArch);

  const mcpCandidates = [
    path.join(cargoTargetRoot, spec.rustTarget, "release", spec.mcpBinaryName),
  ];
  if (options.allowDebugFallback) {
    mcpCandidates.push(
      path.join(cargoTargetRoot, spec.rustTarget, "debug", spec.mcpBinaryName),
    );
  }
  if (isHostTarget) {
    mcpCandidates.push(path.join(cargoTargetRoot, "release", spec.mcpBinaryName));
    if (options.allowDebugFallback) {
      mcpCandidates.push(path.join(cargoTargetRoot, "debug", spec.mcpBinaryName));
    }
  }
  const mcpBinary = firstExisting(mcpCandidates);
  if (!mcpBinary) {
    throw new Error(
      `Missing quill-mcp binary for ${spec.rustTarget} (checked ${mcpCandidates.join(", ")})`,
    );
  }
  assertBinaryArch(mcpBinary, spec.expectedBinaryArch);

  // Never fall back to `binaries/macos/libpdfium.dylib`, which tracks whichever
  // target ran build.rs last and can contain the wrong architecture in cross-builds.
  const pdfiumLib = path.join(projectDir, spec.pdfiumRelativePath);
  if (!fs.existsSync(pdfiumLib)) {
    throw new Error(
      `Missing target-arch pdfium library for ${spec.rustTarget} at ${pdfiumLib}`,
    );
  }
  assertBinaryArch(pdfiumLib, spec.expectedBinaryArch);

  const dictCandidates = [
    path.join(projectDir, "crates", "quill-core", "resources", "dict.db"),
  ];
  if (options.allowDebugFallback) {
    dictCandidates.push(
      path.join(projectDir, "crates", "quill-core", "resources", "dict-test.db"),
    );
  }
  const dictDb = firstExisting(dictCandidates);
  if (!dictDb) {
    throw new Error(
      `Missing built-in dictionary database (checked ${dictCandidates.join(", ")})`,
    );
  }

  return {
    spec,
    nodeAddon,
    mcpBinary,
    pdfiumLib,
    dictDb,
  };
}

export async function stageNativeResourcesIntoPack(context: AfterPackContext): Promise<void> {
  const projectDir = context.packager.projectDir;
  const resourcesDir = context.packager.getResourcesDir(context.appOutDir);
  const sources = resolveNativeBundleSources(
    projectDir,
    context.electronPlatformName,
    context.arch,
    {
      allowDebugFallback: process.env.QUILL_PACK_ALLOW_DEBUG === "1",
      envRustTarget: process.env.QUILL_RUST_TARGET,
      cargoTargetDir: process.env.CARGO_TARGET_DIR,
    },
  );

  const nodeDest = path.join(resourcesDir, "quill-node", "index.node");
  fs.mkdirSync(path.dirname(nodeDest), { recursive: true });
  fs.copyFileSync(sources.nodeAddon, nodeDest);

  const mcpDest = path.join(resourcesDir, sources.spec.mcpBinaryName);
  fs.copyFileSync(sources.mcpBinary, mcpDest);
  if (sources.spec.platform === "darwin") {
    fs.chmodSync(mcpDest, 0o755);
  }

  const pdfiumDest = path.join(resourcesDir, sources.spec.pdfiumDestName);
  fs.copyFileSync(sources.pdfiumLib, pdfiumDest);

  const dictDest = path.join(resourcesDir, "dict.db");
  fs.copyFileSync(sources.dictDb, dictDest);
}
