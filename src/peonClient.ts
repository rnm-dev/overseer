import { Readable } from "node:stream";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { baseUrl, type PeonRecord } from "./registry.js";

// The overseer's south-bound client: how it calls a peon's unified fleet API. Every
// call carries the peon's credential token + the acting operator via Peon-Actor.

const PROTOCOL = 1;
export const PEON_API_PATH = "/api/v1";

export interface PeonConn {
  baseUrl: string;
  token: string;
}

export function connOfRecord(record: PeonRecord): PeonConn {
  return { baseUrl: baseUrl(record), token: record.token };
}

// Accept whatever address an operator pastes at recruit time (with/without scheme,
// tolerating a trailing fleet API path) and return the server base. Removing the
// API path here ensures callers never duplicate the version segment.
export function normalizePeonUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    let path = u.pathname.replace(/\/+$/, "");
    if (path.endsWith(PEON_API_PATH)) path = path.slice(0, -PEON_API_PATH.length);
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
}

function apiUrl(conn: PeonConn, pathname: string): string {
  const base = conn.baseUrl.replace(/\/+$/, "");
  const serverBase = base.endsWith(PEON_API_PATH) ? base.slice(0, -PEON_API_PATH.length) : base;
  return `${serverBase}${PEON_API_PATH}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

function headers(token: string, actor: string | null, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Peon-Protocol": String(PROTOCOL),
    ...extra,
  };
  if (actor) h["Peon-Actor"] = actor;
  return h;
}

export interface PeonCallResult {
  status: number;
  ok: boolean;
  json: unknown;
}

interface ProxyErrorResponse {
  status: number;
  contentType: string;
  body: string;
}

// Older Peons may surface Node filesystem errors as an unstructured 500. Keep
// unrelated failures intact, but turn genuine access errors (and explicit 403s)
// into a stable response the web client can explain to the operator.
export function normalizeProxyError(status: number, text: string, contentType = "application/json"): ProxyErrorResponse {
  const isPermissionFailure = status === 403 || (status >= 500 && /\b(?:EACCES|EPERM)\b|permission denied|operation not permitted/i.test(text));
  if (isPermissionFailure) {
    return {
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Permission denied — the Peon process cannot read or write this file or directory.",
        code: "FILE_PERMISSION_DENIED",
      }),
    };
  }
  return { status, contentType, body: text };
}

// A JSON request/response call to a peon. Network failures (peon offline,
// unreachable over the tailnet) surface as a synthetic 502 rather than throwing,
// so the operator API always answers with a structured error.
export async function callPeon(
  conn: PeonConn,
  method: string,
  pathname: string,
  opts: { actor?: string | null; body?: unknown; timeoutMs?: number; requestId?: string } = {},
): Promise<PeonCallResult> {
  const url = apiUrl(conn, pathname);
  try {
    const res = await fetch(url, {
      method,
      headers: headers(conn.token, opts.actor ?? null, {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(opts.requestId ? { "Peon-Request-Id": opts.requestId } : {}),
      }),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    return { status: res.status, ok: res.ok, json };
  } catch (err) {
    return { status: 502, ok: false, json: { error: `peon unreachable: ${err instanceof Error ? err.message : String(err)}`, code: "PEON_UNREACHABLE" } };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

// Streams a peon's SSE endpoint straight through to an operator's response — the
// overseer is a transparent pipe for live session tails, adding only its own
// credential auth on the peon side. Cleans up the upstream fetch when the
// operator disconnects.
export async function proxyStream(conn: PeonConn, pathname: string, res: ExpressResponse, actor: string | null = null): Promise<void> {
  const url = apiUrl(conn, pathname);
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(url, { headers: headers(conn.token, actor), signal: controller.signal });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: `peon unreachable: ${err instanceof Error ? err.message : String(err)}`, code: "PEON_UNREACHABLE" });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    // Initial stream failures are ordinary Peon API errors (unknown session,
    // invalid path, missing file, ...). Preserve Peon's stable code/message
    // instead of hiding them behind a generic proxy error.
    const text = await upstream.text().catch(() => "");
    res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text || JSON.stringify({ error: "peon stream error", code: "PEON_STREAM_ERROR" }));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // aborted (operator disconnected) or upstream died — either way just end.
  } finally {
    res.end();
  }
}

// Like proxyStream, but pushes decoded SSE text to a callback instead of an
// Express response — used to bridge a peon's session tail onto a client
// WebSocket (liveSocket.ts). Resolves when the stream ends or `signal` aborts;
// throws only if the initial connect fails.
const STREAM_CONNECT_TIMEOUT_MS = 15_000;

export async function streamPeonTo(conn: PeonConn, pathname: string, onChunk: (text: string) => void, signal: AbortSignal, actor: string | null = null): Promise<void> {
  const url = apiUrl(conn, pathname);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const connectTimer = setTimeout(() => controller.abort(new Error("peon stream connect timeout")), STREAM_CONNECT_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, { headers: headers(conn.token, actor), signal: controller.signal });
    clearTimeout(connectTimer); // the long-lived body has connected; only the caller owns its lifetime now
    if (!upstream.ok || !upstream.body) throw new Error(`peon stream ${upstream.status}`);
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onChunk(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) onChunk(tail);
  } catch (err) {
    // An intentional unsubscribe is silent. A genuine upstream/read/parse failure
    // reaches the tail owner so it can emit one retryable tailError.
    if (!signal.aborted) throw err;
  } finally {
    clearTimeout(connectTimer);
    signal.removeEventListener("abort", abort);
  }
}

const FILE_TRANSFER_TIMEOUT_MS = 5 * 60_000;

// Transparent streamed GET proxy to an arbitrary fleet path (API-relative, query
// included). Forwards Range, copies transfer headers, streams the
// body; JSON (stat/listing/error) passes through unchanged. Unreachable ⇒ 502.
export async function proxyGet(conn: PeonConn, pathname: string, req: ExpressRequest, res: ExpressResponse, actor: string | null = null): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const upstreamHeaders = headers(conn.token, actor);
  if (typeof req.headers.range === "string") upstreamHeaders.Range = req.headers.range;

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(apiUrl(conn, pathname), { headers: upstreamHeaders, signal: controller.signal });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: `peon unreachable: ${msg(err)}`, code: "PEON_UNREACHABLE" });
    return;
  }
  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const error = normalizeProxyError(upstream.status, text, upstream.headers.get("content-type") ?? "application/json");
    res.status(error.status).type(error.contentType).send(error.body);
    return;
  }
  res.status(upstream.status);
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "peon-content-sha256"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) return void res.end();
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } catch {
    // operator disconnected or upstream died
  } finally {
    res.end();
  }
}

// Download (or ?stat=) proxy for the /files sandbox — thin wrapper over proxyGet.
export async function proxyFileDownload(conn: PeonConn, segments: string[], req: ExpressRequest, res: ExpressResponse, actor: string | null = null): Promise<void> {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const encoded = segments.map(encodeURIComponent).join("/");
  return proxyGet(conn, `/files/${encoded}${qs}`, req, res, actor);
}

// Upload proxy — streams the operator's request body straight through to the
// peon (no buffering), forwarding the Peon-Content-Sha256 integrity header so the
// peon can verify what it committed. Relays the peon's JSON result verbatim.
export async function proxyFileUpload(conn: PeonConn, segments: string[], req: ExpressRequest, res: ExpressResponse, actor: string | null = null): Promise<void> {
  const encoded = segments.map(encodeURIComponent).join("/");
  return proxyUpload(conn, `/files/${encoded}`, req, res, actor);
}

// Stream a raw upload to any API-relative Peon path. Project uploads use this
// same transport but let the Peon enforce the selected project's root sandbox.
export async function proxyUpload(conn: PeonConn, pathname: string, req: ExpressRequest, res: ExpressResponse, actor: string | null = null): Promise<void> {
  const upstreamHeaders = headers(conn.token, actor, { "Content-Type": "application/octet-stream" });
  if (typeof req.headers["peon-content-sha256"] === "string") upstreamHeaders["Peon-Content-Sha256"] = req.headers["peon-content-sha256"];

  try {
    const upstream = await fetch(apiUrl(conn, pathname), {
      method: "PUT",
      headers: upstreamHeaders,
      // Node streams the request body; duplex:"half" is required to send a stream.
      body: Readable.toWeb(req) as unknown as BodyInit,
      duplex: "half",
      signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
    } as RequestInit);
    const text = await upstream.text();
    if (!upstream.ok) {
      const error = normalizeProxyError(upstream.status, text, upstream.headers.get("content-type") ?? "application/json");
      res.status(error.status).type(error.contentType).send(error.body);
      return;
    }
    res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: `peon unreachable: ${msg(err)}`, code: "PEON_UNREACHABLE" });
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
