import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import { baseUrl } from "../../registry.js";
import type { PeonRecord } from "../registry/registryTypes.js";
import type {
  PeonCallOptions,
  PeonCallResult,
  PeonConn,
  ProxyErrorResponse,
} from "./peonClientTypes.js";

export const PROTOCOL = 1;
export const PEON_API_PATH = "/api/v1";

export function connOfRecord(record: PeonRecord): PeonConn {
  return { baseUrl: baseUrl(record), token: record.token };
}

export function normalizePeonUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || !u.hostname) return null;
    if (u.username || u.password || s.includes("?") || s.includes("#")) return null;
    const authority = s.slice(s.indexOf("//") + 2).split(/[/?#]/, 1)[0];
    const port = authority.startsWith("[")
      ? authority.match(/^\[[^\]]+\]:(\d+)$/)?.[1]
      : authority.match(/:(\d+)$/)?.[1];
    if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
    const host = `${u.hostname}${port ? `:${port}` : ""}`;
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${host}${path}`;
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

export interface PeonCallOptionsInner {
  actor?: string | null;
  body?: unknown;
  timeoutMs?: number;
  requestId?: string;
}

export async function callPeon(
  conn: PeonConn,
  method: string,
  pathname: string,
  opts: PeonCallOptions = {},
): Promise<PeonCallResult> {
  const url = apiUrl(conn, pathname);
  const requestId = opts.requestId ?? randomUUID();
  try {
    const res = await fetch(url, {
      method,
      headers: headers(conn.token, opts.actor ?? null, {
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
        "Peon-Request-Id": requestId,
      }),
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    });
    const text = await res.text();
    const json = text ? safeJson(text) : null;
    const responseRequestId = res.headers.get("peon-request-id") ?? res.headers.get("x-request-id") ?? res.headers.get("x-correlation-id") ?? requestId;
    return { status: res.status, ok: res.ok, json, requestId: responseRequestId };
  } catch (err) {
    return { status: 502, ok: false, json: classifyPeonNetworkError(err) };
  }
}

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

export function classifyPeonNetworkError(err: unknown): { error: string; code: string } {
  const error = err as Error & { cause?: { code?: string; message?: string } };
  const code = error?.cause?.code ?? "";
  const detail = [error?.message, error?.cause?.message].filter(Boolean).join(": ");
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return { code: "DNS_FAILURE", error: "the Peon domain could not be resolved" };
  if (code === "ECONNREFUSED") return { code: "CONNECTION_REFUSED", error: "Overseer resolved the address but the Peon refused the connection" };
  if (error?.name === "TimeoutError" || code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return { code: "CONNECTION_TIMEOUT", error: "Overseer resolved the address but timed out connecting to the Peon" };
  }
  if (/(?:CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|WRONG_VERSION)/i.test(`${code} ${detail}`)) {
    return { code: "TLS_FAILURE", error: `TLS/certificate problem while connecting to the Peon${detail ? `: ${detail}` : ""}` };
  }
  return { error: `peon unreachable: ${detail || String(err)}`, code: "PEON_UNREACHABLE" };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

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

const STREAM_CONNECT_TIMEOUT_MS = 15_000;

export async function streamPeonTo(
  conn: PeonConn,
  pathname: string,
  onChunk: (text: string) => void,
  signal: AbortSignal,
  actor: string | null = null,
  lastEventId: string | null = null,
): Promise<void> {
  const url = apiUrl(conn, pathname);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  const connectTimer = setTimeout(() => controller.abort(new Error("peon stream connect timeout")), STREAM_CONNECT_TIMEOUT_MS);
  try {
    const upstream = await fetch(url, {
      headers: headers(conn.token, actor, lastEventId ? { "Last-Event-ID": lastEventId } : {}),
      signal: controller.signal,
    });
    clearTimeout(connectTimer);
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
    if (!signal.aborted) throw err;
  } finally {
    clearTimeout(connectTimer);
    signal.removeEventListener("abort", abort);
  }
}

const FILE_TRANSFER_TIMEOUT_MS = 5 * 60_000;

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

export async function proxyFileDownload(conn: PeonConn, segments: string[], req: ExpressRequest, res: ExpressResponse, actor: string | null = null): Promise<void> {
  const qs = req.originalUrl.includes("?") ? req.originalUrl.slice(req.originalUrl.indexOf("?")) : "";
  const encoded = segments.map(encodeURIComponent).join("/");
  return proxyGet(conn, `/files/${encoded}${qs}`, req, res, actor);
}

export async function proxyFileUpload(conn: PeonConn, segments: string[], req: ExpressRequest, res: ExpressResponse, actor: string | null = null): Promise<void> {
  const encoded = segments.map(encodeURIComponent).join("/");
  return proxyUpload(conn, `/files/${encoded}`, req, res, actor);
}

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
