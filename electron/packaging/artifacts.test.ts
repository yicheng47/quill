import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MacUpdater } from "electron-updater/out/MacUpdater";
import { assertBinaryArch, detectBinaryArchs } from "../../scripts/binary-arch.mjs";
import { mergeMacUpdateYml, verifyMergedMacUpdateYml } from "../../scripts/merge-mac-update-yml.mjs";
import { resolveMacBundleVersion, resolveNativeBundleSources } from "./artifacts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quill-pack-test-"));
  tempDirs.push(dir);
  return dir;
}

function makeMachoHeader(cpuType: number): Buffer {
  const buf = Buffer.alloc(32);
  buf.writeUInt32LE(0xfeedfacf, 0);
  buf.writeUInt32LE(cpuType, 4);
  return buf;
}

function makePeHeader(machine: number): Buffer {
  const buf = Buffer.alloc(128);
  buf[0] = 0x4d; // M
  buf[1] = 0x5a; // Z
  buf.writeUInt32LE(0x40, 0x3c);
  buf.write("PE\0\0", 0x40, "ascii");
  buf.writeUInt16LE(machine, 0x44);
  return buf;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("binary-arch", () => {
  it("detects thin Mach-O arm64/x64 and Windows PE x64 headers", () => {
    expect(detectBinaryArchs(makeMachoHeader(0x0100000c))).toEqual(["arm64"]);
    expect(detectBinaryArchs(makeMachoHeader(0x01000007))).toEqual(["x64"]);
    expect(detectBinaryArchs(makePeHeader(0x8664))).toEqual(["x64"]);
  });

  it("rejects mismatched binary architectures", () => {
    const dir = makeTempDir();
    const arm64File = path.join(dir, "libpdfium.dylib");
    fs.writeFileSync(arm64File, makeMachoHeader(0x0100000c));

    expect(assertBinaryArch(arm64File, "arm64")).toEqual(["arm64"]);
    expect(() => assertBinaryArch(arm64File, "x64")).toThrow(/Binary architecture mismatch/);
  });
});

describe("resolveNativeBundleSources", () => {
  it("resolves target-specific x64 macOS artifacts and rejects arm64 cross-contamination", () => {
    const repo = makeTempDir();
    const x64Node = path.join(repo, "out", "native", "x86_64-apple-darwin", "index.node");
    const x64Mcp = path.join(repo, "target", "x86_64-apple-darwin", "release", "quill-mcp");
    const x64Pdfium = path.join(
      repo,
      "crates",
      "quill-core",
      "binaries",
      "macos-x86_64",
      "libpdfium.dylib",
    );
    const arm64Pdfium = path.join(
      repo,
      "crates",
      "quill-core",
      "binaries",
      "macos",
      "libpdfium.dylib",
    );
    const dictDb = path.join(repo, "crates", "quill-core", "resources", "dict.db");

    for (const p of [x64Node, x64Mcp, x64Pdfium, arm64Pdfium, dictDb]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
    }
    fs.writeFileSync(x64Node, makeMachoHeader(0x01000007));
    fs.writeFileSync(x64Mcp, makeMachoHeader(0x01000007));
    fs.writeFileSync(x64Pdfium, makeMachoHeader(0x01000007));
    // Even if `binaries/macos/libpdfium.dylib` holds arm64 from a prior build, x64 must ignore it.
    fs.writeFileSync(arm64Pdfium, makeMachoHeader(0x0100000c));
    fs.writeFileSync(dictDb, "SQLite format 3\0");

    const resolved = resolveNativeBundleSources(repo, "darwin", "x64", {
      hostPlatform: "darwin",
      hostArch: "arm64",
    });
    expect(resolved.nodeAddon).toBe(x64Node);
    expect(resolved.mcpBinary).toBe(x64Mcp);
    expect(resolved.pdfiumLib).toBe(x64Pdfium);
    expect(resolved.dictDb).toBe(dictDb);

    // If `macos-x86_64/libpdfium.dylib` is overwritten by arm64, resolution fails loudly.
    fs.writeFileSync(x64Pdfium, makeMachoHeader(0x0100000c));
    expect(() =>
      resolveNativeBundleSources(repo, "darwin", "x64", {
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
    ).toThrow(/Binary architecture mismatch/);
  });

  it("never falls back to host target/release/quill-mcp on macOS x64 cross-builds", () => {
    const repo = makeTempDir();
    const hostReleaseMcp = path.join(repo, "target", "release", "quill-mcp");
    const x64Node = path.join(repo, "crates", "quill-node", "index.node");
    const x64Pdfium = path.join(
      repo,
      "crates",
      "quill-core",
      "binaries",
      "macos-x86_64",
      "libpdfium.dylib",
    );
    for (const p of [hostReleaseMcp, x64Node, x64Pdfium]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
    }
    fs.writeFileSync(hostReleaseMcp, makeMachoHeader(0x0100000c));
    fs.writeFileSync(x64Node, makeMachoHeader(0x01000007));
    fs.writeFileSync(x64Pdfium, makeMachoHeader(0x01000007));

    expect(() =>
      resolveNativeBundleSources(repo, "darwin", "x64", {
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
    ).toThrow(/Missing quill-mcp binary for x86_64-apple-darwin/);
  });

  it("allows dict-test.db fallback only when allowDebugFallback is true", () => {
    const repo = makeTempDir();
    const arm64Node = path.join(repo, "crates", "quill-node", "index.node");
    const arm64Mcp = path.join(repo, "target", "release", "quill-mcp");
    const arm64Pdfium = path.join(
      repo,
      "crates",
      "quill-core",
      "binaries",
      "macos-aarch64",
      "libpdfium.dylib",
    );
    const dictTestDb = path.join(repo, "crates", "quill-core", "resources", "dict-test.db");

    for (const p of [arm64Node, arm64Mcp, arm64Pdfium, dictTestDb]) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
    }
    fs.writeFileSync(arm64Node, makeMachoHeader(0x0100000c));
    fs.writeFileSync(arm64Mcp, makeMachoHeader(0x0100000c));
    fs.writeFileSync(arm64Pdfium, makeMachoHeader(0x0100000c));
    fs.writeFileSync(dictTestDb, "fixture");

    expect(() =>
      resolveNativeBundleSources(repo, "darwin", "arm64", {
        hostPlatform: "darwin",
        hostArch: "arm64",
      }),
    ).toThrow(/Missing built-in dictionary database/);

    const resolved = resolveNativeBundleSources(repo, "darwin", "arm64", {
      hostPlatform: "darwin",
      hostArch: "arm64",
      allowDebugFallback: true,
    });
    expect(resolved.dictDb).toBe(dictTestDb);
  });
});

class TestableMacUpdater extends MacUpdater {
  static filterByArch = MacUpdater.filterFilesForArch;
}

describe("mergeMacUpdateYml", () => {
  const arm64Yml = `version: 2.0.0-nightly.202611171930
files:
  - url: Quill-2.0.0-nightly.202611171930-arm64-mac.zip
    sha512: arm64ZipSha
    size: 100
  - url: Quill-2.0.0-nightly.202611171930-arm64.dmg
    sha512: arm64DmgSha
    size: 110
path: Quill-2.0.0-nightly.202611171930-arm64-mac.zip
sha512: arm64ZipSha
releaseDate: '2026-11-17T19:30:00.000Z'
`;

  const x64Yml = `version: 2.0.0-nightly.202611171930
files:
  - url: Quill-2.0.0-nightly.202611171930-x64-mac.zip
    sha512: x64ZipSha
    size: 200
  - url: Quill-2.0.0-nightly.202611171930-x64.dmg
    sha512: x64DmgSha
    size: 210
path: Quill-2.0.0-nightly.202611171930-x64-mac.zip
sha512: x64ZipSha
releaseDate: '2026-11-17T19:31:00.000Z'
`;

  it("merges arm64 and x64 latest-mac.yml with zips first and MacUpdater arch compatibility", () => {
    const mergedText = mergeMacUpdateYml(arm64Yml, x64Yml);
    const merged = verifyMergedMacUpdateYml(mergedText, "2.0.0-nightly.202611171930");

    expect(merged.files.map((f) => f.url)).toEqual([
      "Quill-2.0.0-nightly.202611171930-x64-mac.zip",
      "Quill-2.0.0-nightly.202611171930-arm64-mac.zip",
      "Quill-2.0.0-nightly.202611171930-x64.dmg",
      "Quill-2.0.0-nightly.202611171930-arm64.dmg",
    ]);
    expect(merged.path).toBe("Quill-2.0.0-nightly.202611171930-x64-mac.zip");
    expect(merged.sha512).toBe("x64ZipSha");
    expect(merged.releaseDate).toBe("2026-11-17T19:31:00.000Z");

    const resolved = merged.files.map((info) => ({
      url: new URL(`https://example.com/${info.url}`),
      info,
    }));
    expect(TestableMacUpdater.filterByArch(resolved, true).map((f) => f.info.url)).toEqual([
      "Quill-2.0.0-nightly.202611171930-arm64-mac.zip",
      "Quill-2.0.0-nightly.202611171930-arm64.dmg",
    ]);
    expect(TestableMacUpdater.filterByArch(resolved, false).map((f) => f.info.url)).toEqual([
      "Quill-2.0.0-nightly.202611171930-x64-mac.zip",
      "Quill-2.0.0-nightly.202611171930-x64.dmg",
    ]);
  });

  it("rejects mismatched versions when merging", () => {
    const other = x64Yml.replaceAll("2.0.0-nightly.202611171930", "2.0.0-nightly.202611171935");
    expect(() => mergeMacUpdateYml(arm64Yml, other)).toThrow(/mismatched versions/);
  });
});

describe("resolveMacBundleVersion", () => {
  it("keeps 1-to-3-component numeric CFBundleVersion across stable, rc, and nightly semver strings", () => {
    const cases: Array<[string, string]> = [
      ["2.0.0", "2.0.0"],
      ["2.0.0-rc.1", "2.0.0"],
      ["2.0.0-nightly.202611171145", "20261117.1145"],
    ];
    for (const [semver, expected] of cases) {
      const actual = resolveMacBundleVersion(semver);
      expect(actual).toBe(expected);
      expect(actual).toMatch(/^\d+(?:\.\d+){0,2}$/);
      expect(actual.length).toBeLessThanOrEqual(18);
    }
  });
});
