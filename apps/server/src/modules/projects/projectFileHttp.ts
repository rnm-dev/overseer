import type { Request, Response } from "express";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { openPeonProjectFile, PeonFileStreamError, type ProjectFileRange } from "../../peonFileStream.js";

export const PROJECT_FILE_CSP = "sandbox allow-scripts allow-forms allow-modals allow-downloads";

const INLINE_MIME_BY_EXTENSION: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".webm": "video/webm",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

export function projectFileContentType(relativePath: string, upstreamType: string): string {
  const inferred = INLINE_MIME_BY_EXTENSION[path.posix.extname(relativePath).toLowerCase()];
  const generic = upstreamType.split(";", 1)[0]?.trim().toLowerCase() === "application/octet-stream";
  return inferred && generic ? inferred : upstreamType;
}

export function isolateProjectFileResponse(res: Pick<Response, "setHeader">): void {
  // Project files are untrusted content. A top-level HTML/SVG/PDF navigation
  // must not inherit the authenticated Overseer origin.
  res.setHeader("Content-Security-Policy", PROJECT_FILE_CSP);
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-store");
}

export function requestedProjectFileRange(value: string | undefined): ProjectFileRange | undefined {
  if (value === undefined) return undefined;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) throw new PeonFileStreamError("INVALID_RANGE", "only one explicit byte range is supported", 416);
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : undefined;
  if (!Number.isSafeInteger(start) || (end !== undefined && (!Number.isSafeInteger(end) || end < start))) {
    throw new PeonFileStreamError("INVALID_RANGE", "invalid byte range", 416);
  }
  return { start, ...(end === undefined ? {} : { end }) };
}

// Which channel serves a project file request. The Peon's HTTP API is being
// retired, so a read rides the transfer socket whenever one is available; the
// proxy answers only for a directory listing (`?stat=1`, which has no socket
// operation yet), for a project the catalog cannot name — the socket addresses
// a file by project ID, never by key — and for a Peon old enough to hold no
// transfer socket at all. Delete the fallback once the fleet has moved.
export function projectFileReadChannel(input: { stat: boolean; transportReady: boolean; projectId: string | null }): "socket" | "proxy" {
  return !input.stat && input.transportReady && input.projectId ? "socket" : "proxy";
}

export async function streamProjectFileResponse(input: {
  req: Request;
  res: Response;
  peonId: string;
  projectId: string;
  relativePath: string;
  actor: { userId: string; email: string };
}): Promise<void> {
  const { req, res } = input;
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => controller.abort());
  try {
    const file = await openPeonProjectFile({
      peonId: input.peonId,
      projectId: input.projectId,
      relativePath: input.relativePath,
      actor: input.actor,
      range: requestedProjectFileRange(typeof req.headers.range === "string" ? req.headers.range : undefined),
      signal: controller.signal,
    });
    isolateProjectFileResponse(res);
    res.status(file.status);
    res.setHeader("Content-Type", projectFileContentType(input.relativePath, file.contentType));
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Length", String(file.contentLength));
    if (file.contentRange) res.setHeader("Content-Range", file.contentRange);
    if (file.acceptRanges) res.setHeader("Accept-Ranges", file.acceptRanges);
    if (file.etag) res.setHeader("ETag", file.etag);
    if (file.lastModified) res.setHeader("Last-Modified", file.lastModified);
    await pipeline(file.stream, res);
  } catch (error) {
    if (res.headersSent || res.destroyed || controller.signal.aborted) {
      if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const typed = error instanceof PeonFileStreamError
      ? error
      : new PeonFileStreamError("PEON_FILE_STREAM_FAILED", "project file stream failed", 502);
    res.status(typed.status === 499 ? 502 : typed.status).json({ error: typed.message, code: typed.code });
  }
}
