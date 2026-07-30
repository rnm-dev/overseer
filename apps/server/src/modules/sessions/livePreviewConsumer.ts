import { createHash, randomUUID } from "node:crypto";
import {
  initialLivePreviewState,
  LIVE_PREVIEW_LIMITS,
  reduceLivePreview,
  validateLivePreviewManifest,
  type LivePreviewAsset,
  type LivePreviewState,
} from "./livePreviewState.js";

const MAX_ACTIVE_INGESTS = 16;
const MAX_PREVIEWS = 256;
const MAX_ACTIVE_BYTES = 512 * 1024 * 1024;
const MAX_VIEWERS_PER_PREVIEW = 64;
const MAX_LEASE_MS = 5 * 60_000;
const CREDIT_WINDOW = 256 * 1024;

export interface LivePreviewKey {
  workspaceId: string;
  peonId: string;
  sessionId: string;
  previewId: string;
}

export interface LivePreviewEvent {
  key: LivePreviewKey;
  status: LivePreviewState["status"];
  revision: number;
  code?: string;
}

interface ViewerLease {
  leaseId: string;
  userId: string;
  expiresAt: number;
}

interface StoredRevision {
  revision: number;
  entryPath: string;
  assets: Map<string, { metadata: LivePreviewAsset; bytes: Buffer }>;
}

interface Ingest {
  key: string;
  generation: string;
  revision: number;
  assets: Map<string, { metadata: LivePreviewAsset; chunks: Buffer[]; received: number }>;
  reservedBytes: number;
  receivedBytes: number;
}

interface PreviewRecord {
  key: LivePreviewKey;
  state: LivePreviewState;
  viewers: Map<string, ViewerLease>;
  upstreamLeaseId: string;
  upstreamExpiresAt: number;
  active: StoredRevision | null;
}

export interface LivePreviewConsumerOptions {
  now?: () => number;
  authorize: (key: LivePreviewKey, userId: string) => Promise<boolean>;
  publish: (event: LivePreviewEvent, authorizedUserIds: readonly string[]) => Promise<void> | void;
  watch: (input: LivePreviewKey & { leaseId: string; expiresAt: number }) => Promise<void>;
  renew: (input: LivePreviewKey & { leaseId: string; expiresAt: number }) => Promise<void>;
  unwatch: (input: LivePreviewKey & { leaseId: string }) => Promise<void>;
}

function storageKey(key: LivePreviewKey): string {
  return `${key.workspaceId}\0${key.peonId}\0${key.sessionId}\0${key.previewId}`;
}

function boundedId(value: string, name: string): void {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > 255) throw new Error(`invalid ${name}`);
}

function validateKey(key: LivePreviewKey): void {
  boundedId(key.workspaceId, "workspace id");
  boundedId(key.peonId, "Peon id");
  boundedId(key.sessionId, "session id");
  boundedId(key.previewId, "preview id");
}

/**
 * Consumer-side seam for preview-revision-v1.
 *
 * Wire decoding deliberately stays in the existing transfer owner. That owner
 * supplies generation-fenced metadata/chunks here and grants more byte credit
 * only from `remainingCredit`; this class never defines another socket dialect.
 */
export class LivePreviewConsumer {
  private readonly previews = new Map<string, PreviewRecord>();
  private readonly ingests = new Map<string, Ingest>();
  private readonly now: () => number;

  constructor(private readonly options: LivePreviewConsumerOptions) {
    this.now = options.now ?? Date.now;
  }

  async acquireViewer(key: LivePreviewKey, userId: string): Promise<{ leaseId: string; expiresAt: number; state: LivePreviewState }> {
    validateKey(key);
    boundedId(userId, "user id");
    if (!(await this.options.authorize(key, userId))) throw new Error("PREVIEW_NOT_FOUND");
    const id = storageKey(key);
    let record = this.previews.get(id);
    if (!record) {
      if (this.previews.size >= MAX_PREVIEWS) throw new Error("PREVIEW_LIMIT");
      record = {
        key: { ...key },
        state: initialLivePreviewState(),
        viewers: new Map(),
        upstreamLeaseId: randomUUID(),
        upstreamExpiresAt: 0,
        active: null,
      };
      this.previews.set(id, record);
    }
    if (record.viewers.size >= MAX_VIEWERS_PER_PREVIEW) throw new Error("PREVIEW_VIEWER_LIMIT");
    const leaseId = randomUUID();
    const expiresAt = this.now() + MAX_LEASE_MS;
    try {
      if (record.viewers.size === 0) {
        await this.options.watch({ ...key, leaseId: record.upstreamLeaseId, expiresAt });
      } else if (expiresAt > record.upstreamExpiresAt) {
        await this.options.renew({ ...key, leaseId: record.upstreamLeaseId, expiresAt });
      }
    } catch (error) {
      if (record.viewers.size === 0) this.previews.delete(id);
      throw error;
    }
    record.upstreamExpiresAt = Math.max(record.upstreamExpiresAt, expiresAt);
    record.viewers.set(leaseId, { leaseId, userId, expiresAt });
    return { leaseId, expiresAt, state: record.state };
  }

  async renewViewer(key: LivePreviewKey, leaseId: string, userId: string): Promise<number> {
    const record = this.previews.get(storageKey(key));
    const viewer = record?.viewers.get(leaseId);
    if (!record || !viewer || viewer.userId !== userId || !(await this.options.authorize(key, userId))) {
      throw new Error("PREVIEW_NOT_FOUND");
    }
    const expiresAt = this.now() + MAX_LEASE_MS;
    if (expiresAt > record.upstreamExpiresAt) {
      await this.options.renew({ ...key, leaseId: record.upstreamLeaseId, expiresAt });
      record.upstreamExpiresAt = expiresAt;
    }
    viewer.expiresAt = expiresAt;
    return expiresAt;
  }

  async releaseViewer(key: LivePreviewKey, leaseId: string, userId: string): Promise<void> {
    const id = storageKey(key);
    const record = this.previews.get(id);
    const viewer = record?.viewers.get(leaseId);
    if (!record || !viewer || viewer.userId !== userId) return;
    record.viewers.delete(leaseId);
    if (record.viewers.size === 0) {
      await this.options.unwatch({ ...key, leaseId: record.upstreamLeaseId });
      record.upstreamExpiresAt = 0;
    }
  }

  begin(key: LivePreviewKey, generation: string, revision: number, assets: readonly LivePreviewAsset[]): number {
    validateKey(key);
    boundedId(generation, "generation");
    const id = storageKey(key);
    const record = this.previews.get(id);
    if (!record || record.viewers.size === 0) throw new Error("UNKNOWN_PREVIEW");
    if (this.ingests.size >= MAX_ACTIVE_INGESTS) throw new Error("PREVIEW_INGEST_LIMIT");
    validateLivePreviewManifest(revision, assets[0]?.path ?? "", assets);
    const next = reduceLivePreview(record.state, { type: "begin", revision });
    if (next === record.state) throw new Error("STALE_PREVIEW_REVISION");
    let reservedBytes = 0;
    const pending = new Map<string, { metadata: LivePreviewAsset; chunks: Buffer[]; received: number }>();
    for (const asset of assets) {
      if (pending.has(asset.path)) throw new Error("DUPLICATE_PREVIEW_ASSET");
      reservedBytes += asset.size;
      if (asset.size > LIVE_PREVIEW_LIMITS.maxAssetBytes || reservedBytes > LIVE_PREVIEW_LIMITS.maxRevisionBytes) {
        throw new Error("PREVIEW_REVISION_TOO_LARGE");
      }
      pending.set(asset.path, { metadata: { ...asset }, chunks: [], received: 0 });
    }
    this.ingests.set(id, { key: id, generation, revision, assets: pending, reservedBytes, receivedBytes: 0 });
    record.state = next;
    void this.publish(record, { key: record.key, status: "uploading", revision });
    return Math.min(CREDIT_WINDOW, reservedBytes);
  }

  pushChunk(key: LivePreviewKey, generation: string, revision: number, assetPath: string, chunk: Buffer): number {
    const ingest = this.currentIngest(key, generation, revision);
    const asset = ingest.assets.get(assetPath);
    if (!asset) throw new Error("UNKNOWN_PREVIEW_ASSET");
    if (chunk.length < 1 || chunk.length > CREDIT_WINDOW || asset.received + chunk.length > asset.metadata.size
      || ingest.receivedBytes + chunk.length > ingest.reservedBytes) {
      throw new Error("INVALID_PREVIEW_CHUNK");
    }
    asset.chunks.push(Buffer.from(chunk));
    asset.received += chunk.length;
    ingest.receivedBytes += chunk.length;
    return ingest.receivedBytes < ingest.reservedBytes ? chunk.length : 0;
  }

  async activate(key: LivePreviewKey, generation: string, revision: number, entryPath: string): Promise<boolean> {
    const id = storageKey(key);
    const ingest = this.currentIngest(key, generation, revision);
    const record = this.previews.get(id)!;
    const stored = new Map<string, { metadata: LivePreviewAsset; bytes: Buffer }>();
    for (const asset of ingest.assets.values()) {
      if (asset.received !== asset.metadata.size) throw new Error("INCOMPLETE_PREVIEW_REVISION");
      const bytes = Buffer.concat(asset.chunks, asset.received);
      if (createHash("sha256").update(bytes).digest("hex") !== asset.metadata.sha256) {
        this.ingests.delete(id);
        record.state = reduceLivePreview(record.state, { type: "fail", revision, code: "PREVIEW_CHECKSUM_MISMATCH" });
        await this.publish(record, { key: record.key, status: "error", revision, code: "PREVIEW_CHECKSUM_MISMATCH" });
        throw new Error("PREVIEW_CHECKSUM_MISMATCH");
      }
      stored.set(asset.metadata.path, { metadata: asset.metadata, bytes });
    }
    const next = reduceLivePreview(record.state, {
      type: "activate",
      revision,
      entryPath,
      assets: [...stored.values()].map((asset) => asset.metadata),
    });
    if (next === record.state || next.status !== "ready") return false;
    const replacedBytes = record.active
      ? [...record.active.assets.values()].reduce((total, asset) => total + asset.metadata.size, 0)
      : 0;
    const nextActiveBytes = this.activeBytes() - replacedBytes + next.active!.totalBytes;
    if (nextActiveBytes > MAX_ACTIVE_BYTES) {
      this.ingests.delete(id);
      record.state = reduceLivePreview(record.state, { type: "fail", revision, code: "PREVIEW_STORAGE_LIMIT" });
      await this.publish(record, { key: record.key, status: "error", revision, code: "PREVIEW_STORAGE_LIMIT" });
      throw new Error("PREVIEW_STORAGE_LIMIT");
    }
    record.active = { revision, entryPath, assets: stored };
    record.state = next;
    this.ingests.delete(id);
    await this.publish(record, { key: record.key, status: "ready", revision });
    return true;
  }

  async deleted(key: LivePreviewKey, generation: string, revision: number): Promise<void> {
    boundedId(generation, "generation");
    const id = storageKey(key);
    const record = this.previews.get(id);
    if (!record) return;
    const next = reduceLivePreview(record.state, { type: "delete", revision });
    if (next === record.state) return;
    this.ingests.delete(id);
    record.active = null;
    record.state = next;
    await this.publish(record, { key: record.key, status: "deleted", revision });
  }

  async cancelGeneration(peonId: string, generation: string): Promise<void> {
    for (const [id, ingest] of this.ingests) {
      const record = this.previews.get(id);
      if (record?.key.peonId !== peonId || ingest.generation !== generation) continue;
      this.ingests.delete(id);
      record.state = { ...record.state, status: "error", ingestRevision: null, errorCode: "TRANSFER_REPLACED" };
      await this.publish(record, { key: record.key, status: "error", revision: ingest.revision, code: "TRANSFER_REPLACED" });
    }
  }

  async readAuthorized(
    key: LivePreviewKey,
    userId: string,
    revision: number,
    assetPath: string,
  ): Promise<{ bytes: Buffer; contentType: string; sha256: string }> {
    const record = this.previews.get(storageKey(key));
    if (!record || !(await this.options.authorize(key, userId))) throw new Error("PREVIEW_NOT_FOUND");
    const active = record.active;
    if (!active || active.revision !== revision) throw new Error("PREVIEW_NOT_FOUND");
    const asset = active.assets.get(assetPath);
    if (!asset) throw new Error("PREVIEW_NOT_FOUND");
    return { bytes: Buffer.from(asset.bytes), contentType: asset.metadata.contentType, sha256: asset.metadata.sha256 };
  }

  async reconcile(): Promise<void> {
    const now = this.now();
    for (const [id, record] of this.previews) {
      for (const viewer of [...record.viewers.values()]) {
        if (viewer.expiresAt > now) continue;
        record.viewers.delete(viewer.leaseId);
      }
      if (record.viewers.size > 0) continue;
      await this.options.unwatch({ ...record.key, leaseId: record.upstreamLeaseId }).catch(() => undefined);
      this.ingests.delete(id);
      record.active = null;
      record.state = reduceLivePreview(record.state, { type: "expire" });
      await this.publish(record, { key: record.key, status: "expired", revision: record.state.activeRevision });
      this.previews.delete(id);
    }
  }

  snapshot(key: LivePreviewKey): LivePreviewState | null {
    return this.previews.get(storageKey(key))?.state ?? null;
  }

  private currentIngest(key: LivePreviewKey, generation: string, revision: number): Ingest {
    const ingest = this.ingests.get(storageKey(key));
    if (!ingest || ingest.generation !== generation || ingest.revision !== revision) throw new Error("STALE_PREVIEW_INGEST");
    return ingest;
  }

  private async publish(record: PreviewRecord, event: LivePreviewEvent): Promise<void> {
    const userIds = [...new Set([...record.viewers.values()].map((viewer) => viewer.userId))];
    await this.options.publish(event, userIds);
  }

  private activeBytes(): number {
    let total = 0;
    for (const record of this.previews.values()) {
      for (const asset of record.active?.assets.values() ?? []) total += asset.metadata.size;
    }
    return total;
  }
}
