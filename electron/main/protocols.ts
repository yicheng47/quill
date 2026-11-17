import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { protocol } from "electron";
import type { QuillCoreInstance } from "./core";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".epub": "application/epub+zip",
  ".pdf": "application/pdf",
};

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

async function isWithinRoot(targetRealPath: string, rootPath: string): Promise<boolean> {
  try {
    const rootReal = await fs.promises.realpath(rootPath);
    const cmpTarget = process.platform === "win32" ? targetRealPath.toLowerCase() : targetRealPath;
    const cmpRoot = process.platform === "win32" ? rootReal.toLowerCase() : rootReal;
    return cmpTarget === cmpRoot || cmpTarget.startsWith(cmpRoot + path.sep);
  } catch {
    return false;
  }
}

export type ParsedByteRange =
  | { kind: "none" }
  | { kind: "range"; start: number; end: number }
  | { kind: "unsatisfiable" };

export function parseByteRange(rangeHeader: string | null, totalSize: number): ParsedByteRange {
  if (!rangeHeader) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  if (!match) return { kind: "none" };

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") {
    return { kind: "none" };
  }
  if (totalSize === 0) {
    return { kind: "unsatisfiable" };
  }

  // Suffix range: bytes=-N (last N bytes)
  if (rawStart === "") {
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      return { kind: "unsatisfiable" };
    }
    const start = Math.max(0, totalSize - suffix);
    return { kind: "range", start, end: totalSize - 1 };
  }

  const start = Number.parseInt(rawStart, 10);
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) {
    return { kind: "unsatisfiable" };
  }

  if (rawEnd === "") {
    return { kind: "range", start, end: totalSize - 1 };
  }

  const parsedEnd = Number.parseInt(rawEnd, 10);
  if (!Number.isFinite(parsedEnd) || parsedEnd < start) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "range", start, end: Math.min(parsedEnd, totalSize - 1) };
}

export async function serveFileResponse(
  filePath: string,
  rangeHeader: string | null,
): Promise<Response> {
  const stat = await fs.promises.stat(filePath);
  const total = stat.size;
  const contentType = mimeTypeFor(filePath);
  const parsed = parseByteRange(rangeHeader, total);

  if (parsed.kind === "unsatisfiable") {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  }

  if (parsed.kind === "range") {
    const { start, end } = parsed;
    const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end })) as ReadableStream;
    return new Response(stream, {
      status: 206,
      headers: {
        "Content-Type": contentType,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      },
    });
  }

  if (total === 0) {
    return new Response(new Uint8Array(0), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Length": "0",
      },
    });
  }

  const stream = Readable.toWeb(fs.createReadStream(filePath)) as ReadableStream;
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Content-Length": String(total),
    },
  });
}

export function registerProtocols(core: QuillCoreInstance, rendererDistDir: string): void {
  const resolvedDist = fs.existsSync(rendererDistDir)
    ? fs.realpathSync(rendererDistDir)
    : path.resolve(rendererDistDir);

  protocol.handle("quill-app", async (request) => {
    const url = new URL(request.url);
    const decodedPath = decodeURIComponent(url.pathname);
    const relative = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
    const candidate = path.resolve(resolvedDist, relative);

    try {
      const stat = await fs.promises.stat(candidate);
      if (stat.isFile()) {
        const real = await fs.promises.realpath(candidate);
        if (await isWithinRoot(real, resolvedDist)) {
          return await serveFileResponse(real, request.headers.get("Range"));
        }
      }
    } catch {
      // Static file missing; fall through to SPA index.html.
    }

    const indexPath = path.join(resolvedDist, "index.html");
    if (fs.existsSync(indexPath)) {
      return serveFileResponse(indexPath, null);
    }
    return new Response("Not Found", { status: 404 });
  });

  protocol.handle("quill-file", async (request) => {
    const url = new URL(request.url);
    const rawPath = url.searchParams.get("path");
    if (!rawPath) {
      return new Response("Missing path parameter", { status: 400 });
    }

    let realPath: string;
    try {
      realPath = await fs.promises.realpath(rawPath);
    } catch {
      return new Response("Not Found", { status: 404 });
    }

    const roots = await core.allowedMediaRoots();
    const checks = await Promise.all(roots.map((root) => isWithinRoot(realPath, root)));
    if (!checks.some(Boolean)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      const stat = await fs.promises.stat(realPath);
      if (!stat.isFile()) {
        return new Response("Not Found", { status: 404 });
      }
      return await serveFileResponse(realPath, request.headers.get("Range"));
    } catch {
      return new Response("Internal Error", { status: 500 });
    }
  });
}
