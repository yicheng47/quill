import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  protocol: { handle: vi.fn() },
}));

import { parseByteRange, serveFileResponse } from "./protocols";

const tempDirs: string[] = [];

function makeFixture(filename: string, contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quill-proto-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("protocols byte range handling", () => {
  it("parses suffix, closed, open, clamped, and unsatisfiable ranges accurately", () => {
    expect(parseByteRange("bytes=-4", 16)).toEqual({ kind: "range", start: 12, end: 15 });
    expect(parseByteRange("bytes=-100", 16)).toEqual({ kind: "range", start: 0, end: 15 });
    expect(parseByteRange("bytes=-0", 16)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=0-3", 16)).toEqual({ kind: "range", start: 0, end: 3 });
    expect(parseByteRange("bytes=12-", 16)).toEqual({ kind: "range", start: 12, end: 15 });
    expect(parseByteRange("bytes=12-999", 16)).toEqual({ kind: "range", start: 12, end: 15 });
    expect(parseByteRange("bytes=16-", 16)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=5-2", 16)).toEqual({ kind: "unsatisfiable" });
    expect(parseByteRange("bytes=-4", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("serves exact bytes for suffix and normal ranges on a real file", async () => {
    const filePath = makeFixture("sample.epub", "0123456789abcdef");

    const suffix = await serveFileResponse(filePath, "bytes=-4");
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("Content-Range")).toBe("bytes 12-15/16");
    expect(suffix.headers.get("Content-Length")).toBe("4");
    expect(await suffix.text()).toBe("cdef");

    const oversizedSuffix = await serveFileResponse(filePath, "bytes=-100");
    expect(oversizedSuffix.status).toBe(206);
    expect(oversizedSuffix.headers.get("Content-Range")).toBe("bytes 0-15/16");
    expect(await oversizedSuffix.text()).toBe("0123456789abcdef");

    const zeroSuffix = await serveFileResponse(filePath, "bytes=-0");
    expect(zeroSuffix.status).toBe(416);
    expect(zeroSuffix.headers.get("Content-Range")).toBe("bytes */16");

    const prefix = await serveFileResponse(filePath, "bytes=0-3");
    expect(prefix.status).toBe(206);
    expect(prefix.headers.get("Content-Range")).toBe("bytes 0-3/16");
    expect(await prefix.text()).toBe("0123");

    const oob = await serveFileResponse(filePath, "bytes=16-");
    expect(oob.status).toBe(416);
    expect(oob.headers.get("Content-Range")).toBe("bytes */16");
  });

  it("serves empty files with 200 OK and rejects ranges on empty files with 416", async () => {
    const emptyPath = makeFixture("empty.pdf", "");

    const ok = await serveFileResponse(emptyPath, null);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Length")).toBe("0");
    expect(await ok.text()).toBe("");

    const range = await serveFileResponse(emptyPath, "bytes=-4");
    expect(range.status).toBe(416);
    expect(range.headers.get("Content-Range")).toBe("bytes */0");
  });
});
