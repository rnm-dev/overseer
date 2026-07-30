import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export const RELEASE_LATEST_PATH = "/api/v1/releases/latest";

export interface PeonRelease {
  id: string;
  version: string;
  revision: string;
  sha256: string;
  sizeBytes: number;
  createdAt: string;
}

export interface ReleaseCredentials {
  baseUrl: string;
  token: string;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parsePeonRelease(value: unknown): PeonRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release metadata is not an object");
  const record = value as Record<string, unknown>;
  const version = nonEmpty(record.version);
  const id = nonEmpty(record.id) ?? version;
  const revision = nonEmpty(record.revision);
  const sha256 = nonEmpty(record.sha256)?.toLowerCase() ?? null;
  const sizeBytes = record.sizeBytes ?? record.size;
  const rawCreatedAt = record.createdAt ?? record.publishedAt;
  const createdAt = typeof rawCreatedAt === "number" && Number.isFinite(rawCreatedAt)
    ? new Date(rawCreatedAt).toISOString()
    : nonEmpty(rawCreatedAt);
  if (!version) throw new Error("release metadata has no version");
  if (!id) throw new Error("release metadata has no id");
  if (!revision || !/^[0-9A-Za-z._:+-]{1,128}$/.test(revision)) throw new Error("release metadata has an invalid revision");
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("release metadata has an invalid sha256");
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0) throw new Error("release metadata has an invalid sizeBytes");
  if (!createdAt || Number.isNaN(Date.parse(createdAt))) throw new Error("release metadata has an invalid createdAt");
  return { id, version, revision, sha256, sizeBytes: sizeBytes as number, createdAt };
}

function endpoint(baseUrl: string, pathname: string): URL {
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new Error("overseerUrl must use http or https");
  return new URL(pathname, `${base.origin}/`);
}

export function releaseArchiveUrl(baseUrl: string, release: Pick<PeonRelease, "id">): URL {
  return endpoint(baseUrl, `/api/v1/releases/${encodeURIComponent(release.id)}/archive`);
}

export function releaseHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" };
}

export async function fetchLatestRelease(
  credentials: ReleaseCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<PeonRelease | null> {
  const response = await fetchImpl(endpoint(credentials.baseUrl, RELEASE_LATEST_PATH), {
    headers: releaseHeaders(credentials.token),
  });
  if (response.status === 404) {
    const body = await response.json().catch(() => null) as { code?: unknown } | null;
    if (body?.code === "NO_RELEASES") return null;
  }
  if (!response.ok) throw new Error(`Overseer release lookup failed (${response.status} ${response.statusText})`);
  const body = await response.json() as unknown;
  // Current Overseer responses use `{ release: ... }`; accept the former
  // direct-metadata response too so older control planes remain compatible.
  const metadata = body && typeof body === "object" && !Array.isArray(body) && "release" in body
    ? (body as { release: unknown }).release
    : body;
  return parsePeonRelease(metadata);
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
