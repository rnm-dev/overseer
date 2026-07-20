import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type { Request } from "express";
import { config } from "./config.js";
import { query } from "./db.js";

export interface ReleaseRecord {
  version: string;
  storageKey: string;
  size: number;
  sha256: string;
  createdAt: number;
}

interface ReleaseRow {
  version: string;
  storage_key: string;
  size: number;
  sha256: string;
  created_at: number;
}

export class ReleaseError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const validReleaseVersion = (version: string): boolean => /^[0-9A-Za-z][0-9A-Za-z._+-]{0,127}$/.test(version);

const fromRow = (row: ReleaseRow): ReleaseRecord => ({
  version: row.version,
  storageKey: row.storage_key,
  size: Number(row.size),
  sha256: row.sha256,
  createdAt: Number(row.created_at),
});

export async function latestRelease(): Promise<ReleaseRecord | null> {
  const { rows } = await query<ReleaseRow>(
    `SELECT version,storage_key,size,sha256,created_at FROM releases ORDER BY created_at DESC, version DESC LIMIT 1`,
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export async function getRelease(version: string): Promise<ReleaseRecord | null> {
  const { rows } = await query<ReleaseRow>(
    `SELECT version,storage_key,size,sha256,created_at FROM releases WHERE version=$1`, [version],
  );
  return rows[0] ? fromRow(rows[0]) : null;
}

export function releasePath(record: Pick<ReleaseRecord, "storageKey">): string {
  if (!/^[a-f0-9]{64}$/.test(record.storageKey)) throw new ReleaseError(500, "INVALID_RELEASE_STORAGE", "release storage metadata is invalid");
  return path.join(config.releaseDirectory, "blobs", record.storageKey);
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) throw new Error("release archive write made no progress");
    offset += bytesWritten;
  }
}

export async function ensureReleaseFile(record: ReleaseRecord): Promise<string> {
  const file = releasePath(record);
  try {
    await access(file, constants.R_OK);
    const info = await stat(file);
    if (!info.isFile() || info.size !== record.size) throw new Error("archive size differs from metadata");
    return file;
  } catch {
    throw new ReleaseError(404, "ARCHIVE_MISSING", "release archive is missing");
  }
}

export async function publishRelease(version: string, req: Request): Promise<ReleaseRecord> {
  if (!validReleaseVersion(version)) throw new ReleaseError(400, "INVALID_VERSION", "version contains unsupported characters");
  if (await getRelease(version)) throw new ReleaseError(409, "RELEASE_EXISTS", "release version already exists");

  const expected = typeof req.headers["peon-content-sha256"] === "string" ? req.headers["peon-content-sha256"].toLowerCase() : null;
  if (expected && !/^[a-f0-9]{64}$/.test(expected)) throw new ReleaseError(400, "INVALID_CHECKSUM", "Peon-Content-Sha256 must be a SHA-256 hex digest");
  const declaredSize = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredSize) && declaredSize > config.releaseMaxBytes) throw new ReleaseError(413, "RELEASE_TOO_LARGE", "release archive exceeds the configured limit");

  const tempDir = path.join(config.releaseDirectory, "tmp");
  const blobDir = path.join(config.releaseDirectory, "blobs");
  await mkdir(tempDir, { recursive: true });
  await mkdir(blobDir, { recursive: true });
  const tempPath = path.join(tempDir, randomUUID());
  const handle = await open(tempPath, "wx", 0o600);
  const hash = createHash("sha256");
  let size = 0;
  let closed = false;
  try {
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      size += chunk.length;
      if (size > config.releaseMaxBytes) throw new ReleaseError(413, "RELEASE_TOO_LARGE", "release archive exceeds the configured limit");
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    await handle.sync();
    await handle.close();
    closed = true;
    if (size === 0) throw new ReleaseError(400, "EMPTY_ARCHIVE", "release archive is empty");
    const sha256 = hash.digest("hex");
    if (expected && expected !== sha256) throw new ReleaseError(409, "CHECKSUM_MISMATCH", "release archive checksum does not match");
    const blobPath = path.join(blobDir, sha256);
    try {
      await access(blobPath, constants.F_OK);
      await unlink(tempPath);
    } catch {
      await rename(tempPath, blobPath);
    }
    const createdAt = Date.now();
    try {
      await query(
        `INSERT INTO releases (version,storage_key,size,sha256,created_at) VALUES ($1,$2,$3,$4,$5)`,
        [version, sha256, size, sha256, createdAt],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ReleaseError(409, "RELEASE_EXISTS", "release version already exists");
      throw error;
    }
    return { version, storageKey: sha256, size, sha256, createdAt };
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }
}
