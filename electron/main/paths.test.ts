import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveDictPath, resolveMcpBinaryPath } from "./paths";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quill-paths-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveMcpBinaryPath", () => {
  it("throws instead of falling back to release binary in dev mode", () => {
    const repo = makeTempRepo();
    const releaseDir = path.join(repo, "target", "release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(path.join(releaseDir, "quill-mcp"), "release-bin");

    expect(() =>
      resolveMcpBinaryPath(repo, { isPackaged: false, platform: "darwin" }),
    ).toThrow(/Development quill-mcp binary not found/);
  });

  it("returns target/debug/quill-mcp in dev mode when present", () => {
    const repo = makeTempRepo();
    const debugDir = path.join(repo, "target", "debug");
    fs.mkdirSync(debugDir, { recursive: true });
    const bin = path.join(debugDir, "quill-mcp");
    fs.writeFileSync(bin, "debug-bin");

    expect(
      resolveMcpBinaryPath(repo, { isPackaged: false, platform: "darwin" }),
    ).toBe(bin);
  });

  it("honors CARGO_TARGET_DIR in dev mode and never falls back to repo target/release", () => {
    const repo = makeTempRepo();
    const customTarget = makeTempRepo();
    const customDebug = path.join(customTarget, "debug");
    fs.mkdirSync(customDebug, { recursive: true });
    const bin = path.join(customDebug, "quill-mcp.exe");
    fs.writeFileSync(bin, "debug-win");

    expect(
      resolveMcpBinaryPath(repo, {
        isPackaged: false,
        platform: "win32",
        cargoTargetDir: customTarget,
      }),
    ).toBe(bin);
  });
});

describe("resolveDictPath", () => {
  it("resolves QUILL_DICT_PATH override before repo dict.db in dev mode", () => {
    const repo = makeTempRepo();
    const resourcesDir = path.join(repo, "crates", "quill-core", "resources");
    fs.mkdirSync(resourcesDir, { recursive: true });
    const repoDict = path.join(resourcesDir, "dict.db");
    const overrideDict = path.join(repo, "custom-dict.db");
    fs.writeFileSync(repoDict, "repo-dict");
    fs.writeFileSync(overrideDict, "override-dict");

    expect(
      resolveDictPath(repo, { isPackaged: false, envDictPath: overrideDict }),
    ).toBe(overrideDict);
    expect(resolveDictPath(repo, { isPackaged: false })).toBe(repoDict);
  });

  it("returns undefined gracefully when dict.db is absent in dev or packaged mode", () => {
    const repo = makeTempRepo();
    expect(resolveDictPath(repo, { isPackaged: false })).toBeUndefined();
    expect(resolveDictPath(repo, { isPackaged: true, resourcesPath: repo })).toBeUndefined();
  });

  it("resolves resources/dict.db in packaged mode", () => {
    const resources = makeTempRepo();
    const packagedDict = path.join(resources, "dict.db");
    fs.writeFileSync(packagedDict, "packaged-dict");

    expect(
      resolveDictPath("/unused", { isPackaged: true, resourcesPath: resources }),
    ).toBe(packagedDict);
  });
});
