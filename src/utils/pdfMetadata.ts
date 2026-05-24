import { convertFileSrc } from "@tauri-apps/api/core";

export interface PdfMetadata {
  title: string;
  author: string | null;
  description: string | null;
  pages: number;
  coverData: Uint8Array | null;
}

// 5s backstop. The primary stall mode (#222) is fixed by passing a
// self-constructed Worker via `workerPort` below — pdf.js's own
// `_isSameOrigin`/`_createCDNWrapper` path sees `tauri://localhost`'s
// opaque origin as "null", wraps the worker in a blob that re-imports the
// tauri:// URL, and that pattern stalls silently inside macOS 14.x
// WKWebView. With `workerPort` we skip that whole path; the timeout is
// only a safety net for genuinely slow PDFs / unrelated stalls.
const PDF_METADATA_TIMEOUT_MS = 5_000;

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
  // Hoisted so the timeout path can cancel pdf.js even if we never reach
  // the inner await — destroy() releases the worker and the cmap/font fetches.
  // Typed `any` to match `pdfjs.getDocument(...)`'s any-return from the
  // untyped dynamic import.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let loadingTask: any = null;
  // pdf.js doesn't terminate Workers it receives via `workerPort` (only ones
  // it constructs itself), so we own this Worker's lifecycle end-to-end.
  let worker: Worker | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(
        new Error(
          `timed out after ${PDF_METADATA_TIMEOUT_MS / 1000}s at "${step}" — pdf.js stopped responding`,
        ),
      );
    }, PDF_METADATA_TIMEOUT_MS);
  });

  const work = async (): Promise<PdfMetadata> => {
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
    // See PDF_METADATA_TIMEOUT_MS comment for why we bypass `workerSrc`.
    // A self-constructed module Worker routes through pdf.js's
    // `#initializeFromPort` and skips `_createCDNWrapper`'s blob shim.
    worker = new Worker(workerUrl, { type: "module" });
    if (pdfjs.GlobalWorkerOptions) {
      pdfjs.GlobalWorkerOptions.workerPort = worker;
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
    loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false,
    });

    step = "loadingTask.promise";
    const pdf = await loadingTask!.promise;

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
  };

  try {
    return await Promise.race([work(), timeoutPromise]);
  } catch (err) {
    // Best-effort cleanup so pdf.js releases the worker — but do NOT await.
    // `PDFDocumentLoadingTask.destroy()` waits on transport teardown, which
    // sends "Terminate" to the worker and waits for a reply (pdf.mjs:15593).
    // If the original stall is a nonresponsive worker, awaiting here would
    // re-hang the importer for the full event loop. Fire-and-forget instead:
    // the worker leaks until page reload in the pathological case, but the
    // user gets the filename-only fallback immediately.
    if (loadingTask) {
      try {
        loadingTask.destroy?.()?.catch?.(() => {});
      } catch {
        // Ignore — original error is what matters
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    const stackSnippet =
      err instanceof Error && err.stack
        ? ` | ${err.stack.split("\n").slice(0, 2).join(" / ")}`
        : "";
    throw new Error(`PDF metadata failed at "${step}": ${message}${stackSnippet}`);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
    // pdf.js skips terminating ports it didn't construct (pdf.mjs:15378-15386
    // — `#webWorker` is only set in the self-construct path), so terminate
    // here. Safe to call after a successful pdf.destroy() too — terminating
    // an already-shut-down worker is a no-op.
    worker?.terminate();
  }
}

/**
 * Render page 1 of a PDF to a PNG Uint8Array. Used for cover backfill
 * after MCP or Rust-side imports that don't have access to pdf.js.
 */
export async function extractPdfCover(filePath: string): Promise<Uint8Array | null> {
  const url = convertFileSrc(filePath);
  const response = await fetch(url);
  if (!response.ok) return null;
  const buffer = await response.arrayBuffer();

  const pdfjsUrl = new URL("/foliate-js/vendor/pdfjs/pdf.mjs", window.location.origin).href;
  const pdfjs = await import(/* @vite-ignore */ pdfjsUrl);

  const workerUrl = new URL("/foliate-js/vendor/pdfjs/pdf.worker.mjs", window.location.origin).href;
  const worker = new Worker(workerUrl, { type: "module" });
  if (pdfjs.GlobalWorkerOptions) {
    pdfjs.GlobalWorkerOptions.workerPort = worker;
  }

  const cMapUrl = new URL("/foliate-js/vendor/pdfjs/cmaps/", window.location.origin).href;
  const standardFontDataUrl = new URL("/foliate-js/vendor/pdfjs/standard_fonts/", window.location.origin).href;

  try {
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buffer),
      cMapUrl,
      cMapPacked: true,
      standardFontDataUrl,
      isEvalSupported: false,
    });
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob: Blob | null = await new Promise((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/png"),
    );
    pdf.destroy?.();
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    worker.terminate();
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
