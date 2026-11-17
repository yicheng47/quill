/** @vitest-environment jsdom */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let outputDir: string;
let rendererDir: string;
let assetPaths: string[];

beforeAll(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "quill-renderer-test-"));
  execFileSync(
    process.execPath,
    [
      path.resolve("node_modules/electron-vite/bin/electron-vite.js"),
      "build",
      "--outDir",
      outputDir,
    ],
    { timeout: 60_000, stdio: "pipe" },
  );
  rendererDir = path.join(outputDir, "renderer");
  const html = fs.readFileSync(path.join(rendererDir, "index.html"), "utf8");
  const document = new DOMParser().parseFromString(html, "text/html");
  const scripts = Array.from(document.querySelectorAll('script[type="module"][src]'));
  const styles = Array.from(document.querySelectorAll('link[rel="stylesheet"][href]'));
  expect(scripts.length).toBeGreaterThan(0);
  expect(styles.length).toBeGreaterThan(0);
  assetPaths = [
    ...scripts.map((script) => script.getAttribute("src")!),
    ...styles.map((style) => style.getAttribute("href")!),
  ];
}, 60_000);

afterAll(() => {
  if (outputDir) fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("packaged renderer assets", () => {
  it.each([
    "quill-app://app/",
    "quill-app://app/reader/book-1",
    "quill-app://app/reader/book-1?openChat=true&cfi=chapter-2",
  ])("loads the built JavaScript and CSS from %s", (pageUrl) => {
    for (const assetPath of assetPaths) {
      const url = new URL(assetPath, pageUrl);
      expect(url.protocol).toBe("quill-app:");
      expect(url.host).toBe("app");
      const filePath = path.join(rendererDir, url.pathname.slice(1));
      expect(fs.existsSync(filePath), `${url.href} must resolve to a built asset`).toBe(true);
    }
  });
});
