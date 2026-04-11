import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

export interface Book {
  id: string;
  title: string;
  author: string;
  description: string | null;
  cover_path: string | null;
  file_path: string;
  format: "epub" | "pdf";
  genre: string | null;
  pages: number | null;
  status: "reading" | "finished" | "unread";
  progress: number;
  current_cfi: string | null;
  created_at: string;
  updated_at: string;
  available: boolean;
}

export function useBooks(filter?: string, search?: string) {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await invoke<Book[]>("list_books", {
        filter: filter || null,
        search: search || null,
      });
      setBooks(result);
    } catch (err) {
      console.error("Failed to load books:", err);
    } finally {
      setLoading(false);
    }
  }, [filter, search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { books, loading, refresh };
}

async function pickFile(): Promise<string | null> {
  return open({
    multiple: false,
    filters: [{ name: "Books", extensions: ["epub", "pdf"] }],
  });
}

async function importFile(
  filePath: string,
  onMetadataWarning?: (warning: string) => void,
): Promise<Book> {
  if (!filePath.toLowerCase().endsWith(".pdf")) {
    return invoke<Book>("import_book", { filePath });
  }

  // PDF.js uses Promise.withResolvers() everywhere internally. That API
  // shipped in Safari 17.4 / macOS Sonoma 14.4; older systems can't load
  // PDF.js at all. Fail fast with a clear message instead of letting it
  // explode deep inside pdf.mjs with "undefined is not a function".
  if (typeof (Promise as unknown as { withResolvers?: unknown }).withResolvers !== "function") {
    throw new Error(
      "PDF support requires macOS 14.4 (Sonoma) or later. Please update macOS to import PDFs. EPUB files work on older systems.",
    );
  }

  // PDF: stage → extract metadata from the staged copy → commit.
  // Staging into $APPDATA/books/ avoids fetching arbitrary user paths via
  // the asset protocol, which can fail on some Macs (TCC, scope, encoding).
  const staged = await invoke<{ book_id: string; abs_path: string }>("stage_pdf_import", {
    sourcePath: filePath,
  });
  try {
    const { extractPdfMetadata, filenameToTitle } = await import("../utils/pdfMetadata");
    let meta;
    try {
      meta = await extractPdfMetadata(staged.abs_path);
    } catch (err) {
      // Metadata extraction failed (PDF.js error, missing CMaps, malformed
      // PDF, etc.). Don't block the import — fall back to filename-based
      // metadata so the user still gets their book. Surface the diagnostic
      // via onMetadataWarning so we can debug what actually broke.
      const message = err instanceof Error ? err.message : String(err);
      console.warn("PDF metadata extraction failed, importing with filename only:", err);
      onMetadataWarning?.(message);
      meta = {
        title: filenameToTitle(filePath),
        author: null,
        description: null,
        pages: 0,
        coverData: null as Uint8Array | null,
      };
    }
    return await invoke<Book>("commit_pdf_import", {
      bookId: staged.book_id,
      title: meta.title,
      author: meta.author,
      description: meta.description,
      pages: meta.pages,
      coverData: meta.coverData ? Array.from(meta.coverData) : null,
    });
  } catch (err) {
    try {
      await invoke("cancel_pdf_import", { bookId: staged.book_id });
    } catch {
      // Ignore rollback failure — original error is more useful
    }
    throw err;
  }
}

export const importBookDialog = { pickFile, importFile };

export async function getBook(id: string): Promise<Book> {
  return invoke<Book>("get_book", { id });
}

export async function deleteBook(id: string): Promise<void> {
  return invoke("delete_book", { id });
}

export async function updateReadingProgress(
  id: string,
  progress: number,
  cfi?: string
): Promise<void> {
  return invoke("update_reading_progress", {
    id,
    progress,
    cfi: cfi || null,
  });
}

export async function markFinished(id: string): Promise<void> {
  return invoke("mark_finished", { id });
}

export async function updateBookStatus(id: string, status: "reading" | "finished" | "unread"): Promise<void> {
  return invoke("update_book_status", { id, status });
}

export async function updateBookMetadata(
  id: string,
  title: string,
  author: string
): Promise<void> {
  return invoke("update_book_metadata", { id, title, author });
}

export async function checkBookAvailable(id: string): Promise<boolean> {
  return invoke<boolean>("check_book_available", { id });
}
