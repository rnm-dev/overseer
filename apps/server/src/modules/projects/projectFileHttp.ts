import type { Request, Response } from "express";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { auditSafeFileErrorBody } from "../../fileErrorSafety.js";
import { openPeonProjectFile, openPeonSandboxFile, openPeonSessionArtifact, PeonFileStreamError, type ProjectFileRange } from "../../peonFileStream.js";

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

const SESSION_ARTIFACT_INLINE_MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

export function sessionArtifactContentType(filePath: string): string {
  return SESSION_ARTIFACT_INLINE_MIME_BY_EXTENSION[path.posix.extname(filePath).toLowerCase()]
    ?? "application/octet-stream";
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

// Which channel serves a project file body. Directory listings are routed
// separately through folder-listing-v1. HTTP remains only for an older Peon
// with no negotiated transfer capability; a modern peer whose catalog identity
// is temporarily unavailable must not switch authorities.
export function projectFileReadChannel(input: { transportReady: boolean; projectId: string | null }): "socket" | "proxy" | "unavailable" {
  if (!input.transportReady) return "proxy";
  return input.projectId ? "socket" : "unavailable";
}

export function projectFileWriteChannel(input: { capabilityReady: boolean; projectId: string | null }): "socket" | "proxy" | "unavailable" {
  if (!input.capabilityReady) return "proxy";
  return input.projectId ? "socket" : "unavailable";
}

export function sandboxFileWriteChannel(input: { capabilityReady: boolean }): "socket" | "proxy" {
  return input.capabilityReady ? "socket" : "proxy";
}

export function projectFolderReadChannel(input: {
  confirmedDirectory: boolean;
  metadataReady: boolean;
  projectId: string | null;
}): "socket" | "proxy" | "unavailable" {
  if (!input.confirmedDirectory || !input.metadataReady) return "proxy";
  return input.projectId ? "socket" : "unavailable";
}

// `directory=1` is an Overseer-private transport hint. Remove only parameters
// whose decoded name is exactly `directory`, retaining the original spelling,
// ordering, repetition, encoding, and empty values of every other parameter.
export function projectFileProxyQuery(originalUrl: string): string {
  const marker = originalUrl.indexOf("?");
  if (marker < 0) return "";
  const raw = originalUrl.slice(marker + 1);
  const kept = raw.split("&").filter((part) => {
    const rawName = part.slice(0, part.indexOf("=") < 0 ? part.length : part.indexOf("="));
    try {
      return decodeURIComponent(rawName.replace(/\+/g, " ")) !== "directory";
    } catch {
      return true;
    }
  });
  return kept.length && kept.some((part) => part.length > 0) ? `?${kept.join("&")}` : "";
}

interface StreamFileResponseInput {
  req: Request;
  res: Response;
  displayPath: string;
  failureMessage: string;
  contentType?: string;
  open(signal: AbortSignal): ReturnType<typeof openPeonProjectFile>;
}

async function streamFileResponse(input: StreamFileResponseInput): Promise<void> {
  const { req, res } = input;
  const controller = new AbortController();
  req.once("aborted", () => controller.abort());
  res.once("close", () => controller.abort());
  try {
    const file = await input.open(controller.signal);
    isolateProjectFileResponse(res);
    res.status(file.status);
    res.setHeader("Content-Type", input.contentType ?? projectFileContentType(input.displayPath, file.contentType));
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
      : new PeonFileStreamError("PEON_FILE_STREAM_FAILED", input.failureMessage, 502);
    res.status(typed.status === 499 ? 502 : typed.status).json(auditSafeFileErrorBody(typed));
  }
}

export async function streamProjectFileResponse(input: {
  req: Request;
  res: Response;
  peonId: string;
  projectId: string;
  relativePath: string;
  actor: { userId: string; email: string };
}): Promise<void> {
  return streamFileResponse({
    req: input.req,
    res: input.res,
    displayPath: input.relativePath,
    failureMessage: "project file stream failed",
    open: (signal) => openPeonProjectFile({
      peonId: input.peonId,
      projectId: input.projectId,
      relativePath: input.relativePath,
      actor: input.actor,
      range: requestedProjectFileRange(typeof input.req.headers.range === "string" ? input.req.headers.range : undefined),
      signal,
    }),
  });
}

export async function streamSandboxFileResponse(input: {
  req: Request;
  res: Response;
  peonId: string;
  path: string;
  actor: { userId: string; email: string };
}): Promise<void> {
  return streamFileResponse({
    req: input.req,
    res: input.res,
    displayPath: input.path,
    failureMessage: "sandbox file stream failed",
    open: (signal) => openPeonSandboxFile({
      peonId: input.peonId,
      path: input.path,
      actor: input.actor,
      range: requestedProjectFileRange(typeof input.req.headers.range === "string" ? input.req.headers.range : undefined),
      signal,
    }),
  });
}

export async function streamSessionArtifactResponse(input: {
  req: Request;
  res: Response;
  peonId: string;
  sessionId: string;
  path: string;
  actor: { userId: string; email: string };
}): Promise<void> {
  return streamFileResponse({
    req: input.req,
    res: input.res,
    displayPath: input.path,
    failureMessage: "session artifact stream failed",
    open: (signal) => openPeonSessionArtifact({
      peonId: input.peonId,
      sessionId: input.sessionId,
      path: input.path,
      actor: input.actor,
      range: requestedProjectFileRange(typeof input.req.headers.range === "string" ? input.req.headers.range : undefined),
      signal,
    }),
    contentType: sessionArtifactContentType(input.path),
  });
}
