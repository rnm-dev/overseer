import { Readable } from "node:stream";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { baseUrl, type PeonRecord } from "./registry.js";

// The overseer's south-bound client: how it calls a peon's /agent/v1 API. Every
// call carries the peon's credential token + the acting operator via Peon-Actor.

const PROTOCOL = 1;

export interface PeonConn {
  baseUrl: string;
  token: string;
}

export function connOfRecord(record: PeonRecord): PeonConn {
  return { baseUrl: baseUrl(record), token: record.token };
}

// Accept whatever address an operator pastes at recruit time (with/without scheme,
// tolerating a trailing /agent/v1) and return the base the peon's /agent/v1 hangs off.
export function normalizePeonUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/+$/, "").replace(/\/agent\/v1$/, "");
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return null;
  }
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

// A JSON request/response call to a peon. Network failures (peon offline,
// unreachable over the tailnet) surface as a synthetic 502 rather than throwing,
// so the operator API always answers with a structured error.
export async function callPeon(
  conn: PeonConn,
  method: string,
  pathname: string,
  opts: { actor?: string | null; body?: unknown; timeoutMs?: number } = {},
): Promise<PeonCallResult> {
  const url = `${conn.baseUrl}/agent/v1${pathname}`;
  try {
    const res = await fetch(url, {
      method,
      headers: headers(conn.token, opts.actor ?? null, opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
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
export async function proxyStream(conn: PeonConn, pathname: string, res: ExpressResponse): Promise<void> {
  const url = `${conn.baseUrl}/agent/v1${pathname}`;
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(url, { headers: headers(conn.token, null), signal: controller.signal });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: `peon unreachable: ${err instanceof Error ? err.message : String(err)}`, code: "PEON_UNREACHABLE" });
    return;
  }
  if (!upstream.ok || !upstream.body) {
    res.status(upstream.status).json({ error: "peon stream error", code: "PEON_STREAM_ERROR" });
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
export async function streamPeonTo(conn: PeonConn, pathname: string, onChunk: (text: string) => void, signal: AbortSignal): Promise<void> {
  const url = `${conn.baseUrl}/agent/v1${pathname}`;
  const upstream = await fetch(url, { headers: headers(conn.token, null), signal });
  if (!upstream.ok || !upstream.body) throw new Error(`peon stream ${upstream.status}`);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) onChunk(decoder.decode(value, { stream: true }));
    }
  } catch {
    // aborted (client unsubscribed) or upstream died — caller cleans up.
  }
}

const FILE_TRANSFER_TIMEOUT_MS = 5 * 60_000;

function filesUrl(conn: PeonConn, segments: string[], query: string): string {
  const encoded = segments.map(encodeURIComponent).join("/");
  return `${conn.baseUrl}/agent/v1/files/${encoded}${query}`;
}

// Transparent streamed GET proxy to an arbitrary peon path (already `/agent/v1`-
// relative, query included). Forwards Range, copies transfer headers, streams the
// body; JSON (stat/listing/error) passes through unchanged. Unreachable ⇒ 502.
export async function proxyGet(conn: PeonConn, pathname: string, req: ExpressRequest, res: ExpressResponse): Promise<void> {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const headers: Record<string, string> = { Authorization: `Bearer ${conn.token}`, "Peon-Protocol": "1" };
  if (typeof req.headers.range === "string") headers.Range = req.headers.range;

  let upstream: Awaited<ReturnType<typeof fetch>>;
  try {
    upstream = await fetch(`${conn.baseUrl}/agent/v1${pathname}`, { headers, signal: controller.signal });
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: `peon unreachable: ${msg(err)}`, code: "PEON_UNREACHABLE" });
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
export async function proxyFileDownload(conn: PeonConn, segments: string[], req: ExpressRequest, res: ExpressResponse): Promise<void> {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const encoded = segments.map(encodeURIComponent).join("/");
  return proxyGet(conn, `/files/${encoded}${qs}`, req, res);
}

// Upload proxy — streams the operator's request body straight through to the
// peon (no buffering), forwarding the Peon-Content-Sha256 integrity header so the
// peon can verify what it committed. Relays the peon's JSON result verbatim.
export async function proxyFileUpload(conn: PeonConn, segments: string[], req: ExpressRequest, res: ExpressResponse): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${conn.token}`,
    "Peon-Protocol": "1",
    "Content-Type": "application/octet-stream",
  };
  if (typeof req.headers["peon-content-sha256"] === "string") headers["Peon-Content-Sha256"] = req.headers["peon-content-sha256"];

  try {
    const upstream = await fetch(filesUrl(conn, segments, ""), {
      method: "PUT",
      headers,
      // Node streams the request body; duplex:"half" is required to send a stream.
      body: Readable.toWeb(req) as unknown as BodyInit,
      duplex: "half",
      signal: AbortSignal.timeout(FILE_TRANSFER_TIMEOUT_MS),
    } as RequestInit);
    const text = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get("content-type") ?? "application/json").send(text);
  } catch (err) {
    if (!res.headersSent) res.status(502).json({ error: `peon unreachable: ${msg(err)}`, code: "PEON_UNREACHABLE" });
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
