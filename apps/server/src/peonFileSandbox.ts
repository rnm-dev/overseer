import { callPeon } from "./peonClient.js";
import type { PeonConn } from "./modules/peonClient/peonClientTypes.js";
import { PATH_ESCAPE_PUBLIC_MESSAGE } from "./fileErrorSafety.js";

// The file-transfer API is rooted at the Peon's `fileTransferRoot`, so every
// path under `/files/...` is sandbox-relative. A message attachment, however,
// travels through the transcript as the absolute path the agent Reads
// (`AttachmentInfo.path`), which is all a client has for a message it did not
// just send itself — its own optimistic echo is the only place the relative
// upload path survives. Map the absolute form back into the sandbox here, in
// the one layer that can ask the Peon where its sandbox is, so web and mobile
// both get it without carrying the rule themselves.

const ROOT_TTL_MS = 30_000;
const rootCache = new Map<string, { root: string; expiresAt: number }>();

export class FileSandboxError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export type RootFetcher = (conn: PeonConn, actor: string | null) => Promise<string>;

// A leading empty segment is what an absolute path looks like once it has been
// joined onto `/files/` (`/files//tmp/...`); a relative request never has one.
export function isAbsoluteRequest(segments: string[]): boolean {
  return segments.length > 0 && segments[0] === "";
}

export function absolutePathOf(segments: string[]): string {
  return `/${segments.filter((segment) => segment !== "").join("/")}`;
}

// Absolute path → the segments the Peon's sandbox expects, or null when the
// path does not live under the root at all (a dashboard-uploaded attachment
// under ~/.peon/sessions/<id>/attachments, say — unreachable through /files).
export function sandboxSegmentsOf(root: string, absolutePath: string): string[] | null {
  const normalizedRoot = root.replace(/\/+$/, "");
  if (!normalizedRoot) return null;
  if (absolutePath === normalizedRoot) return [];
  if (!absolutePath.startsWith(`${normalizedRoot}/`)) return null;
  const rest = absolutePath.slice(normalizedRoot.length + 1).split("/").filter((segment) => segment !== "");
  if (rest.some((segment) => segment === "..")) return null;
  return rest;
}

async function fetchFileTransferRoot(conn: PeonConn, actor: string | null): Promise<string> {
  const cached = rootCache.get(conn.baseUrl);
  if (cached && cached.expiresAt > Date.now()) return cached.root;
  const result = await callPeon(conn, "GET", "/settings", { actor });
  if (!result.ok) {
    const body = (result.json ?? {}) as { error?: string; code?: string };
    throw new FileSandboxError(result.status, body.code ?? "PEON_UNREACHABLE", body.error ?? "could not read the Peon file transfer root");
  }
  const root = (result.json as { fileTransferRoot?: unknown } | null)?.fileTransferRoot;
  if (typeof root !== "string" || !root.trim()) {
    throw new FileSandboxError(503, "FILES_DISABLED", "file transfer is disabled on this Peon — set a file transfer root");
  }
  rootCache.set(conn.baseUrl, { root: root.trim(), expiresAt: Date.now() + ROOT_TTL_MS });
  return root.trim();
}

export function clearFileTransferRootCache(): void {
  rootCache.clear();
}

// Relative requests pass through untouched; an absolute one is resolved against
// the Peon's root. Throws FileSandboxError, never a bare failure, so the route
// can answer with a code a client can act on.
export async function resolveSandboxSegments(
  conn: PeonConn,
  segments: string[],
  actor: string | null,
  fetchRoot: RootFetcher = fetchFileTransferRoot,
): Promise<string[]> {
  if (!isAbsoluteRequest(segments)) return segments;
  return resolveAbsolute(conn, absolutePathOf(segments), actor, fetchRoot);
}

// The attachment read surface: one `path` that may arrive in either form. A
// path segment carrying `/` is impossible on the Peon side, so splitting is
// lossless — and a query parameter survives the proxies in front of Overseer,
// which a `//` in the path does not (nginx merges slashes by default).
export async function resolveAttachmentPath(
  conn: PeonConn,
  rawPath: unknown,
  actor: string | null,
  fetchRoot: RootFetcher = fetchFileTransferRoot,
): Promise<string[]> {
  if (typeof rawPath !== "string" || !rawPath.trim()) {
    throw new FileSandboxError(400, "BAD_REQUEST", "path query parameter is required");
  }
  const path = rawPath.trim();
  if (path.startsWith("/")) return resolveAbsolute(conn, absolutePathOf(path.split("/")), actor, fetchRoot);
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "..")) {
    throw new FileSandboxError(400, "PATH_ESCAPE", PATH_ESCAPE_PUBLIC_MESSAGE);
  }
  if (segments.length === 0) throw new FileSandboxError(400, "BAD_REQUEST", "path query parameter is required");
  return segments;
}

async function resolveAbsolute(conn: PeonConn, absolutePath: string, actor: string | null, fetchRoot: RootFetcher): Promise<string[]> {
  const root = await fetchRoot(conn, actor);
  const resolved = sandboxSegmentsOf(root, absolutePath);
  if (!resolved) {
    throw new FileSandboxError(400, "PATH_ESCAPE", PATH_ESCAPE_PUBLIC_MESSAGE);
  }
  return resolved;
}
