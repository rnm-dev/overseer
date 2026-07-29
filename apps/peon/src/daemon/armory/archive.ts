import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import {
  MAX_ARCHIVE_DOWNLOAD_BYTES,
  MAX_ARCHIVE_EXPANDED_BYTES,
  MAX_ARCHIVE_FILE_COUNT,
  type ArmoryManifest,
} from "./contracts.js";
import { ArmoryOperationError } from "./operationCoordinator.js";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const OFFICIAL_RELEASE_PREFIX = "/rnm-dev/armory/releases/download/";
const ALLOWED_RELEASE_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

export interface ArchiveSelection {
  packageId: string;
  version: string;
  minPeonVersion: string;
  platforms: Array<{ os: "darwin" | "linux"; arch: "x64" | "arm64" }>;
  capabilities?: { mcp: boolean };
  archive: { url: string; size: number; sha256: string };
}

export interface DownloadArchiveOptions {
  selection: ArchiveSelection;
  destination: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export async function downloadArchive(options: DownloadArchiveOptions): Promise<{ bytes: number; sha256: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5 * 60_000;
  const maxBytes = Math.min(options.maxBytes ?? MAX_ARCHIVE_DOWNLOAD_BYTES, MAX_ARCHIVE_DOWNLOAD_BYTES);
  if (options.selection.archive.size > maxBytes) throw new ArmoryOperationError("ARCHIVE_TOO_LARGE", "Release archive exceeds the download limit");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  let complete = false;
  try {
    const response = await fetchRelease(fetchImpl, options.selection.archive.url, controller.signal, options.maxRedirects ?? 5);
    if (response.status !== 200 || !response.body) throw new ArmoryOperationError("DOWNLOAD_FAILED", `Release asset returned HTTP ${response.status}`);
    const declaredLength = parseContentLength(response.headers.get("content-length"));
    if (declaredLength !== null && (declaredLength > maxBytes || declaredLength > options.selection.archive.size)) {
      throw new ArmoryOperationError("ARCHIVE_TOO_LARGE", "Release archive exceeds its declared size");
    }
    await mkdir(path.dirname(options.destination), { recursive: true, mode: 0o700 });
    handle = await open(options.destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const reader = response.body.getReader();
    const digest = createHash("sha256");
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes || bytes > options.selection.archive.size) {
        await reader.cancel();
        throw new ArmoryOperationError("ARCHIVE_TOO_LARGE", "Release archive exceeded its expected size while downloading");
      }
      const buffer = Buffer.from(chunk.value);
      digest.update(buffer);
      await handle.write(buffer);
    }
    await handle.sync();
    await handle.close();
    handle = null;
    if (bytes !== options.selection.archive.size) throw new ArmoryOperationError("ARCHIVE_SIZE_MISMATCH", "Release archive size did not match the catalog");
    const sha256 = digest.digest("hex");
    if (sha256 !== options.selection.archive.sha256) throw new ArmoryOperationError("ARCHIVE_DIGEST_MISMATCH", "Release archive digest did not match the catalog");
    complete = true;
    return { bytes, sha256 };
  } catch (error) {
    if (controller.signal.aborted) throw new ArmoryOperationError("DOWNLOAD_TIMEOUT", "Release archive download timed out", { cause: error });
    if (error instanceof ArmoryOperationError) throw error;
    throw new ArmoryOperationError("DOWNLOAD_FAILED", "Release archive download failed", { cause: error });
  } finally {
    clearTimeout(timer);
    await handle?.close().catch(() => undefined);
    if (!complete) await rm(options.destination, { force: true }).catch(() => undefined);
  }
}

async function fetchRelease(fetchImpl: typeof fetch, initialUrl: string, signal: AbortSignal, maxRedirects: number): Promise<Response> {
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    validateReleaseUrl(current, redirects === 0);
    const response = await fetchImpl(current, { redirect: "manual", signal });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel().catch(() => undefined);
    if (redirects === maxRedirects) throw new ArmoryOperationError("DOWNLOAD_REDIRECT_INVALID", "Release asset exceeded its redirect limit");
    const location = response.headers.get("location");
    if (!location) throw new ArmoryOperationError("DOWNLOAD_REDIRECT_INVALID", "Release asset redirect omitted its destination");
    current = new URL(location, current);
  }
  throw new ArmoryOperationError("DOWNLOAD_REDIRECT_INVALID", "Release asset exceeded its redirect limit");
}

function validateReleaseUrl(url: URL, initial: boolean): void {
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new ArmoryOperationError("DOWNLOAD_POLICY_DENIED", "Release asset URL is not permitted");
  }
  if (!ALLOWED_RELEASE_HOSTS.has(url.hostname)) throw new ArmoryOperationError("DOWNLOAD_POLICY_DENIED", "Release asset host is not permitted");
  if (initial && (url.hostname !== "github.com" || !url.pathname.startsWith(OFFICIAL_RELEASE_PREFIX))) {
    throw new ArmoryOperationError("DOWNLOAD_POLICY_DENIED", "Release asset is outside the official Armory release path");
  }
}

function parseContentLength(value: string | null): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new ArmoryOperationError("DOWNLOAD_FAILED", "Release asset returned an invalid content length");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new ArmoryOperationError("ARCHIVE_TOO_LARGE", "Release asset content length is too large");
  return parsed;
}

export interface InspectArchiveOptions {
  archiveFile: string;
  expectedRoot: string;
  maxFiles?: number;
  maxExpandedBytes?: number;
}

export interface InspectedArchive {
  root: string;
  paths: ReadonlySet<string>;
  files: number;
  expandedBytes: number;
}

export async function inspectArchive(options: InspectArchiveOptions): Promise<InspectedArchive> {
  const maxFiles = options.maxFiles ?? MAX_ARCHIVE_FILE_COUNT;
  const maxExpandedBytes = options.maxExpandedBytes ?? MAX_ARCHIVE_EXPANDED_BYTES;
  const paths = new Set<string>();
  const roots = new Set<string>();
  let files = 0;
  let expandedBytes = 0;
  let validationError: ArmoryOperationError | null = null;
  try {
    await tar.list({
      file: options.archiveFile,
      strict: true,
      onentry: (entry) => {
        if (validationError) return;
        try {
          const entryPath = normalizeArchivePath(entry.path);
          if (paths.has(entryPath)) throw new ArmoryOperationError("ARCHIVE_DUPLICATE_PATH", `Archive contains a duplicate path: ${entryPath}`);
          paths.add(entryPath);
          roots.add(entryPath.split("/")[0]!);
          files += 1;
          expandedBytes += entry.size;
          if (files > maxFiles) throw new ArmoryOperationError("ARCHIVE_TOO_MANY_FILES", "Archive contains too many entries");
          if (expandedBytes > maxExpandedBytes) throw new ArmoryOperationError("ARCHIVE_EXPANDED_TOO_LARGE", "Archive expanded size exceeds the limit");
          if (!["File", "OldFile", "Directory", "SymbolicLink", "Link"].includes(entry.type)) {
            throw new ArmoryOperationError("ARCHIVE_SPECIAL_FILE", `Archive contains unsupported entry type: ${entry.type}`);
          }
          if (entry.type === "SymbolicLink" || entry.type === "Link") {
            if (!entry.linkpath) throw new ArmoryOperationError("ARCHIVE_LINK_ESCAPE", "Archive link is missing its target");
            validateArchiveLink(entryPath, entry.linkpath, options.expectedRoot, entry.type === "Link");
          }
        } catch (error) {
          validationError = error instanceof ArmoryOperationError
            ? error
            : new ArmoryOperationError("ARCHIVE_INVALID", "Release archive contains an invalid entry", { cause: error });
        }
      },
    });
  } catch (error) {
    if (error instanceof ArmoryOperationError) throw error;
    throw new ArmoryOperationError("ARCHIVE_INVALID", "Release archive could not be safely inspected", { cause: error });
  }
  if (validationError) throw validationError;
  if (roots.size !== 1 || !roots.has(options.expectedRoot)) throw new ArmoryOperationError("ARCHIVE_ROOT_MISMATCH", "Archive must contain exactly the expected package root");
  if (!paths.has(`${options.expectedRoot}/armory.package.json`)) throw new ArmoryOperationError("MANIFEST_MISSING", "Archive does not contain armory.package.json at its root");
  return { root: options.expectedRoot, paths, files, expandedBytes };
}

export async function extractInspectedArchive(archiveFile: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  try {
    await tar.extract({ file: archiveFile, cwd: destination, strict: true, preservePaths: false, noChmod: true });
  } catch (error) {
    throw new ArmoryOperationError("ARCHIVE_EXTRACTION_FAILED", "Release archive extraction failed", { cause: error });
  }
}

function normalizeArchivePath(value: string): string {
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new ArmoryOperationError("ARCHIVE_PATH_INVALID", "Archive contains an absolute or invalid path");
  }
  const trimmed = value.endsWith("/") ? value.slice(0, -1) : value;
  const parts = trimmed.split("/");
  if (!trimmed || parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ArmoryOperationError("ARCHIVE_PATH_INVALID", "Archive contains a traversing or ambiguous path");
  }
  return parts.join("/");
}

function validateArchiveLink(entryPath: string, linkPath: string, expectedRoot: string, hardLink: boolean): void {
  if (!linkPath || linkPath.includes("\0") || linkPath.includes("\\") || linkPath.startsWith("/") || /^[A-Za-z]:/.test(linkPath)) {
    throw new ArmoryOperationError("ARCHIVE_LINK_ESCAPE", "Archive contains an unsafe link target");
  }
  const base = hardLink ? "/" : `/${path.posix.dirname(entryPath)}`;
  const resolved = path.posix.resolve(base, linkPath);
  const root = `/${expectedRoot}`;
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new ArmoryOperationError("ARCHIVE_LINK_ESCAPE", "Archive link target escapes the package root");
}

export function assertManifestMatchesSelection(manifest: ArmoryManifest, selection: ArchiveSelection): void {
  if (manifest.id !== selection.packageId || manifest.version !== selection.version) {
    throw new ArmoryOperationError("MANIFEST_IDENTITY_MISMATCH", "Manifest identity does not match the selected catalog release");
  }
  if (manifest.minPeonVersion !== selection.minPeonVersion || JSON.stringify(manifest.platforms) !== JSON.stringify(selection.platforms)) {
    throw new ArmoryOperationError("MANIFEST_CATALOG_MISMATCH", "Manifest compatibility claims do not match the catalog");
  }
  if (selection.capabilities && selection.capabilities.mcp !== Boolean(manifest.mcp)) {
    throw new ArmoryOperationError("MANIFEST_CATALOG_MISMATCH", "Manifest MCP capability does not match the catalog");
  }
}
