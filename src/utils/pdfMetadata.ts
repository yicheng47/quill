import { convertFileSrc } from "@tauri-apps/api/core";

interface PdfMetadata {
  title: string;
  author: string | null;
  description: string | null;
  pages: number;
  coverData: Uint8Array | null;
}

/** Extract metadata from a PDF file using foliate-js. */
export async function extractPdfMetadata(filePath: string): Promise<PdfMetadata> {
  // Fetch the PDF file via Tauri's asset protocol
  const url = convertFileSrc(filePath);
  const response = await fetch(url);
  const blob = new File([await response.blob()], "book.pdf");

  // Use foliate-js makeBook to parse the PDF
  // Dynamic import via URL to bypass Vite's static analysis of /public files
  const viewModule = await import(/* @vite-ignore */ new URL("/foliate-js/view.js", window.location.origin).href)
  const makeBook = viewModule.makeBook;
  const book = await makeBook(blob);

  // Extract metadata — PDF.js may return arrays for multi-valued fields
  const meta = book.metadata || {};
  const title = flatten(meta.title) || filenameToTitle(filePath);
  const author = flatten(meta.author) || null;
  const description = flatten(meta.description) || null;
  const pages = book.sections?.length || 0;

  // Extract cover (first page rendered as thumbnail)
  let coverData: Uint8Array | null = null;
  try {
    if (book.getCover) {
      const coverBlob: Blob = await book.getCover();
      if (coverBlob) {
        const buffer = await coverBlob.arrayBuffer();
        coverData = new Uint8Array(buffer);
      }
    }
  } catch {
    // Cover extraction failed — not critical
  }

  // Clean up PDF.js resources
  try {
    book.destroy?.();
  } catch {
    // Ignore cleanup errors
  }

  return { title, author, description, pages, coverData };
}

/** Flatten a value that may be a string, array, or null into a single string. */
function flatten(value: unknown): string | null {
  if (!value) return null;
  if (Array.isArray(value)) return value.join(", ") || null;
  if (typeof value === "string") return value || null;
  return String(value);
}

/** Derive a title from a filename: strip extension, replace separators, title-case. */
function filenameToTitle(filePath: string): string {
  const name = filePath.split("/").pop()?.split("\\").pop() || "Untitled";
  return name
    .replace(/\.pdf$/i, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim() || "Untitled";
}
