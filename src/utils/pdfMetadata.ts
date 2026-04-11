import { convertFileSrc } from "@tauri-apps/api/core";

export interface PdfMetadata {
  title: string;
  author: string | null;
  description: string | null;
  pages: number;
  coverData: Uint8Array | null;
}

/**
 * Extract metadata from a PDF file by importing pdf.mjs directly.
 *
 * We deliberately bypass foliate-js's view.js and pdf.js wrappers: pdf.js
 * does `import './vendor/pdfjs/pdf.mjs'; const pdfjsLib = globalThis.pdfjsLib`,
 * which depends on a side-effect assignment inside pdf.mjs and can leave
 * `pdfjsLib.getDocument` reading as undefined on some Macs — producing the
 * signature "undefined is not a function (near '...}...')" at the
 * `pdfjsLib.getDocument({...}).promise` call site. Using pdf.mjs's named
 * ES-module exports sidesteps the indirection entirely.
 *
 * Each step is labeled so a thrown error names the exact failing step —
 * Safari/JavaScriptCore otherwise refuses to give a useful stack.
 */
export async function extractPdfMetadata(filePath: string): Promise<PdfMetadata> {
  let step = "init";
  try {
    step = "convertFileSrc";
    const url = convertFileSrc(filePath);

    step = "fetch staged file";
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`fetch returned ${response.status} ${response.statusText}`);
    }

    step = "response → ArrayBuffer";
    const buffer = await response.arrayBuffer();

    step = "dynamic import pdf.mjs";
    const pdfjsUrl = new URL("/foliate-js/vendor/pdfjs/pdf.mjs", window.location.origin).href;
    const pdfjs = await import(/* @vite-ignore */ pdfjsUrl);

    step = "configure worker";
    const workerUrl = new URL(
      "/foliate-js/vendor/pdfjs/pdf.worker.mjs",
      window.location.origin,
    ).href;
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    }

    step = "getDocument lookup";
    if (typeof pdfjs.getDocument !== "function") {
      throw new Error(
        `pdfjs.getDocument is ${typeof pdfjs.getDocument}; exports: [${Object.keys(pdfjs).slice(0, 20).join(", ")}${Object.keys(pdfjs).length > 20 ? ", ..." : ""}]`,
      );
    }

    step = "getDocument(buffer)";
    const cMapUrl = new URL("/foliate-js/vendor/pdfjs/cmaps/", window.location.origin).href;
    const standardFontDataUrl = new URL(
      "/foliate-js/vendor/pdfjs/standard_fonts/",
      window.location.origin,
    ).href;
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false,
    });

    step = "loadingTask.promise";
    const pdf = await loadingTask.promise;

    step = "pdf.getMetadata()";
    const metaResult = await pdf.getMetadata();
    const info = (metaResult && metaResult.info) || {};
    const metaObj = metaResult && metaResult.metadata;
    const getMeta = (key: string): string | null => {
      if (metaObj && typeof metaObj.get === "function") {
        const v = metaObj.get(key);
        if (v) return String(v);
      }
      return null;
    };

    const title = getMeta("dc:title") || info.Title || filenameToTitle(filePath);
    const author = getMeta("dc:creator") || info.Author || null;
    const description = getMeta("dc:description") || info.Subject || null;

    step = "pdf.numPages";
    const pages = pdf.numPages || 0;

    step = "render cover";
    let coverData: Uint8Array | null = null;
    try {
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        await page.render({ canvasContext: ctx, viewport }).promise;
        const coverBlob: Blob | null = await new Promise((resolve) =>
          canvas.toBlob((b) => resolve(b), "image/png"),
        );
        if (coverBlob) {
          const coverBuffer = await coverBlob.arrayBuffer();
          coverData = new Uint8Array(coverBuffer);
        }
      }
    } catch {
      // Cover is nice-to-have; if it fails, just skip it
    }

    step = "destroy";
    try {
      pdf.destroy?.();
    } catch {
      // Ignore cleanup errors
    }

    return {
      title: String(title),
      author: author ? String(author) : null,
      description: description ? String(description) : null,
      pages,
      coverData,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stackSnippet =
      err instanceof Error && err.stack
        ? ` | ${err.stack.split("\n").slice(0, 2).join(" / ")}`
        : "";
    const wrapped = new Error(`PDF metadata failed at "${step}": ${message}${stackSnippet}`);
    throw wrapped;
  }
}

/** Derive a title from a filename: strip extension, replace separators, title-case. */
export function filenameToTitle(filePath: string): string {
  const name = filePath.split("/").pop()?.split("\\").pop() || "Untitled";
  return name
    .replace(/\.pdf$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "Untitled";
}
