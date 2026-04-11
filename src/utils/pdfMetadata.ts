import { convertFileSrc } from "@tauri-apps/api/core";

export interface PdfMetadata {
  title: string;
  author: string | null;
  description: string | null;
  pages: number;
  coverData: Uint8Array | null;
}

/**
 * Extract metadata from a PDF file using foliate-js.
 *
 * Each step is labeled so a thrown error names the exact failing step —
 * Safari/JavaScriptCore's "undefined is not a function (near '...}...')"
 * is otherwise impossible to localize without a stack trace.
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

    step = "blob → File";
    const blob = new File([await response.blob()], "book.pdf");

    step = "dynamic import view.js";
    const viewModule = await import(
      /* @vite-ignore */ new URL("/foliate-js/view.js", window.location.origin).href
    );

    step = "viewModule.makeBook lookup";
    if (typeof viewModule.makeBook !== "function") {
      throw new Error(
        `viewModule.makeBook is ${typeof viewModule.makeBook}; exports: [${Object.keys(viewModule).join(", ")}]`
      );
    }
    const makeBook = viewModule.makeBook;

    step = "makeBook(blob)";
    const book = await makeBook(blob);
    if (!book) {
      throw new Error(`makeBook returned ${book}`);
    }

    step = "read metadata";
    const meta = book.metadata || {};
    const title = flatten(meta.title) || filenameToTitle(filePath);
    const author = flatten(meta.author) || null;
    const description = flatten(meta.description) || null;
    const pages = book.sections?.length || 0;

    step = "getCover";
    let coverData: Uint8Array | null = null;
    try {
      if (typeof book.getCover === "function") {
        const coverBlob: Blob = await book.getCover();
        if (coverBlob) {
          const buffer = await coverBlob.arrayBuffer();
          coverData = new Uint8Array(buffer);
        }
      }
    } catch {
      // Cover extraction failed — not critical, continue without one
    }

    step = "destroy";
    try {
      book.destroy?.();
    } catch {
      // Ignore cleanup errors
    }

    return { title, author, description, pages, coverData };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const wrapped = new Error(`PDF metadata failed at "${step}": ${message}`);
    if (err instanceof Error && err.stack) {
      wrapped.stack = err.stack;
    }
    throw wrapped;
  }
}

/** Flatten a value that may be a string, array, or null into a single string. */
function flatten(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.join(", ") || null;
  if (typeof value === "string") return value || null;
  return String(value);
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
