import { randomBytes } from "node:crypto";
import path from "node:path";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { config } from "./config.js";
import { connOfRecord, PEON_API_PATH } from "./peonClient.js";
import { registry } from "./registry.js";

const SANDBOX = "sandbox allow-scripts allow-forms allow-modals allow-downloads";
const MIN_TTL_MS = 30_000;
const MAX_TTL_MS = 60 * 60_000;

interface PreviewGrant {
  peonId: string;
  workspaceId: string;
  sessionId: string;
  root: string;
  expiresAt: number;
  actor?: string | null;
}

// Opaque grants intentionally live only in Overseer memory. A restart revokes
// every outstanding preview, which is a safe failure mode for an ephemeral UI.
const grants = new Map<string, PreviewGrant>();

function tokenTtl(): number {
  return Math.max(MIN_TTL_MS, Math.min(MAX_TTL_MS, config.previewTokenTtlMs));
}

function pruneGrants(now = Date.now()): void {
  const retention = tokenTtl();
  for (const [token, grant] of grants) {
    // Retain a short tombstone window so an expired iframe gets an explicit
    // EXPIRED_PREVIEW response instead of becoming indistinguishable from typo.
    if (grant.expiresAt + retention < now) grants.delete(token);
  }
}

export function mintWebPreview(input: {
  peonId: string;
  workspaceId: string;
  sessionId: string;
  htmlPath: string;
  actor?: string | null;
}): { url: string; expiresAt: number } {
  if (!path.posix.isAbsolute(input.htmlPath) || path.posix.extname(input.htmlPath).toLowerCase() !== ".html") {
    throw new Error("an absolute .html preview path is required");
  }
  const canonicalHtml = path.posix.normalize(input.htmlPath);
  const root = path.posix.dirname(canonicalHtml);
  const expiresAt = Date.now() + tokenTtl();
  // Hex is DNS-label-safe. 128 random bits keeps an unguessable URL even though
  // the grant is deliberately much shorter-lived than an operator session.
  let token: string;
  do token = randomBytes(16).toString("hex"); while (grants.has(token));
  grants.set(token, { ...input, root, expiresAt });
  pruneGrants();
  return { url: `https://${token}.${config.previewDomain}/${encodeURIComponent(path.posix.basename(canonicalHtml))}`, expiresAt };
}

function requestHost(req: Request): string {
  return (req.headers.host ?? "").split(":", 1)[0].toLowerCase().replace(/\.$/, "");
}

function isPreviewHost(req: Request): boolean {
  return requestHost(req).endsWith(`.${config.previewDomain}`);
}

function previewToken(req: Request): string | null {
  const host = requestHost(req);
  const suffix = `.${config.previewDomain}`;
  if (!host.endsWith(suffix)) return null;
  const token = host.slice(0, -suffix.length);
  return /^[a-f0-9]{32}$/.test(token) ? token : null;
}

function isolationHeaders(res: Response): void {
  res.setHeader("Content-Security-Policy", SANDBOX);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  // A cached response could outlive its grant and effectively extend the token.
  res.setHeader("Cache-Control", "no-store");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function statePage(res: Response, status: number, code: string, message: string): void {
  isolationHeaders(res);
  res.status(status).type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Preview unavailable</title><style>html{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#101113;color:#ddd;font:14px ui-monospace,monospace}.box{max-width:34rem;padding:2rem;text-align:center}strong{display:block;margin-bottom:.65rem;color:#ffb36b}</style></head><body><div class="box"><strong>${escapeHtml(code)}</strong>${escapeHtml(message)}</div></body></html>`);
}

function decodedRequestPath(req: Request): string | null {
  const raw = req.originalUrl.split("?", 1)[0];
  try {
    const decoded = decodeURIComponent(raw).replace(/\\/g, "/");
    if (decoded.includes("\0")) return null;
    const segments = decoded.split("/");
    if (segments.includes("..")) return null;
    return decoded;
  } catch {
    return null;
  }
}

function resolveAsset(root: string, requestPath: string): string | null {
  // Prefixing with '.' makes a root-relative URL relative to the preview root,
  // not the Peon's filesystem root. This is what gives /assets/app.js the same
  // preview-root semantics as assets/app.js.
  const candidate = path.posix.resolve(root, `.${requestPath.startsWith("/") ? requestPath : `/${requestPath}`}`);
  return candidate === root || candidate.startsWith(`${root}/`) ? candidate : null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".cjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".svg": "image/svg+xml", ".avif": "image/avif", ".bmp": "image/bmp", ".ico": "image/x-icon",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf", ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
  ".wasm": "application/wasm", ".pdf": "application/pdf",
};

function mimeType(filePath: string): string {
  return MIME[path.posix.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function isDocumentRequest(req: Request, asset: string): boolean {
  return path.posix.extname(asset).toLowerCase() === ".html" || (req.headers.accept ?? "").includes("text/html");
}

async function servePreview(req: Request, res: Response): Promise<void> {
  isolationHeaders(res);
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Range");
    res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges,Content-Length,Content-Range,ETag,Last-Modified");
    res.sendStatus(204);
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") return void res.status(405).send("method not allowed");

  const token = previewToken(req);
  const grant = token ? grants.get(token) : undefined;
  if (!grant) return statePage(res, 404, "MISSING_PREVIEW", "This preview link is invalid or no longer available.");
  if (grant.expiresAt <= Date.now()) return statePage(res, 410, "EXPIRED_PREVIEW", "This preview link has expired. Reopen the artifact from Overseer to create a new one.");

  const requested = decodedRequestPath(req);
  const asset = requested === null ? null : resolveAsset(grant.root, requested);
  if (!asset) return statePage(res, 403, "INVALID_PREVIEW_PATH", "The requested path is outside this preview.");

  const record = await registry.get(grant.peonId);
  if (!record || record.workspaceId !== grant.workspaceId) return statePage(res, 404, "MISSING_PREVIEW", "The Peon for this preview is no longer available.");

  const conn = connOfRecord(record);
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const upstreamHeaders: Record<string, string> = {
    Authorization: `Bearer ${conn.token}`,
    "Peon-Protocol": "1",
    // Keep byte counts and Range offsets stable. Node's fetch transparently
    // decompresses encoded bodies, which would otherwise invalidate Peon's
    // Content-Length/Content-Range while streaming them onward.
    "Accept-Encoding": "identity",
  };
  if (grant.actor) upstreamHeaders["Peon-Actor"] = grant.actor;
  if (typeof req.headers.range === "string") upstreamHeaders.Range = req.headers.range;

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${conn.baseUrl}${PEON_API_PATH}/sessions/${encodeURIComponent(grant.sessionId)}/file/raw?path=${encodeURIComponent(asset)}`, {
      headers: upstreamHeaders,
      signal: controller.signal,
    });
  } catch (err) {
    if (!res.headersSent) statePage(res, 502, "PREVIEW_UNAVAILABLE", `The Peon could not be reached: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const peonType = upstream.headers.get("content-type") ?? "";
  if (upstream.status === 404 && isDocumentRequest(req, asset)) {
    const body = await upstream.text().catch(() => "");
    let missing = body;
    try { missing = String((JSON.parse(body) as { error?: unknown }).error ?? body); } catch { /* plain-text Peon error */ }
    return statePage(res, 404, "MISSING_PREVIEW", missing || "The preview file no longer exists on the Peon.");
  }

  res.status(upstream.status);
  res.setHeader("Content-Type", upstream.ok || upstream.status === 206 ? mimeType(asset) : (peonType || "application/json; charset=utf-8"));
  for (const header of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(header);
    if (value) res.setHeader(header, value);
  }
  res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges,Content-Length,Content-Range,ETag,Last-Modified");
  if (req.method === "HEAD" || !upstream.body) {
    void upstream.body?.cancel();
    return void res.end();
  }

  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // Browser disconnected or the Peon stream ended; the response is no longer
    // recoverable, so close it without leaking proxy internals.
  } finally {
    res.end();
  }
}

// This middleware is mounted before the SPA/API routers. It claims every host
// under the configured wildcard domain (including malformed/missing tokens), so
// a preview hostname can never fall through to the operator SPA.
export const webPreviewHandler: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  if (!isPreviewHost(req)) return next();
  void servePreview(req, res).catch(next);
};
