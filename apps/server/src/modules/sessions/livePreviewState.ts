export type LivePreviewStatus =
  | "pending"
  | "uploading"
  | "ready"
  | "error"
  | "deleted"
  | "expired";

export interface LivePreviewAsset {
  path: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface LivePreviewRevision {
  revision: number;
  entryPath: string;
  assets: readonly LivePreviewAsset[];
  totalBytes: number;
}

export interface LivePreviewState {
  status: LivePreviewStatus;
  activeRevision: number;
  observedRevision: number;
  ingestRevision: number | null;
  active: LivePreviewRevision | null;
  errorCode: string | null;
}

export type LivePreviewAction =
  | { type: "begin"; revision: number }
  | { type: "activate"; revision: number; entryPath: string; assets: readonly LivePreviewAsset[] }
  | { type: "fail"; revision: number; code: string }
  | { type: "delete"; revision: number }
  | { type: "expire" };

export const LIVE_PREVIEW_LIMITS = Object.freeze({
  maxAssets: 128,
  maxAssetBytes: 8 * 1024 * 1024,
  maxRevisionBytes: 32 * 1024 * 1024,
  maxPathBytes: 512,
});

const SAFE_CONTENT_TYPES = new Set([
  "text/html; charset=utf-8",
  "text/css; charset=utf-8",
  "application/javascript; charset=utf-8",
  "application/json; charset=utf-8",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "font/woff",
  "font/woff2",
]);

export function initialLivePreviewState(): LivePreviewState {
  return {
    status: "pending",
    activeRevision: 0,
    observedRevision: 0,
    ingestRevision: null,
    active: null,
    errorCode: null,
  };
}

function validRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("invalid preview revision");
}

function validPath(path: string): boolean {
  if (!path || path.startsWith("/") || path.includes("\\") || Buffer.byteLength(path, "utf8") > LIVE_PREVIEW_LIMITS.maxPathBytes) {
    return false;
  }
  const segments = path.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function validateLivePreviewManifest(
  revision: number,
  entryPath: string,
  assets: readonly LivePreviewAsset[],
): LivePreviewRevision {
  validRevision(revision);
  if (!validPath(entryPath) || assets.length < 1 || assets.length > LIVE_PREVIEW_LIMITS.maxAssets) {
    throw new Error("invalid preview manifest");
  }
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const asset of assets) {
    if (!validPath(asset.path) || paths.has(asset.path)
      || !Number.isSafeInteger(asset.size) || asset.size < 0 || asset.size > LIVE_PREVIEW_LIMITS.maxAssetBytes
      || !/^[0-9a-f]{64}$/.test(asset.sha256) || !SAFE_CONTENT_TYPES.has(asset.contentType)) {
      throw new Error("invalid preview asset");
    }
    paths.add(asset.path);
    totalBytes += asset.size;
    if (totalBytes > LIVE_PREVIEW_LIMITS.maxRevisionBytes) throw new Error("preview revision too large");
  }
  if (!paths.has(entryPath)) throw new Error("preview entry missing");
  return { revision, entryPath, assets: assets.map((asset) => ({ ...asset })), totalBytes };
}

/**
 * Pure lifecycle core for OVSR-52. Transfer decoding and authorized serving
 * adapt to this reducer without adding another transport lifecycle.
 */
export function reduceLivePreview(state: LivePreviewState, action: LivePreviewAction): LivePreviewState {
  if (action.type === "expire") {
    return state.status === "expired" ? state : { ...state, status: "expired", ingestRevision: null, errorCode: null };
  }

  validRevision(action.revision);
  if (state.status === "expired") return state;
  if (action.type === "begin" && action.revision <= state.observedRevision) return state;
  if (action.type !== "begin" && action.revision < state.observedRevision) return state;
  if (state.ingestRevision !== null && action.revision < state.ingestRevision) return state;

  if (action.type === "begin") {
    return {
      ...state,
      status: "uploading",
      observedRevision: action.revision,
      ingestRevision: action.revision,
      errorCode: null,
    };
  }
  if (action.type === "activate") {
    if (state.ingestRevision !== action.revision) return state;
    const active = validateLivePreviewManifest(action.revision, action.entryPath, action.assets);
    return {
      status: "ready",
      activeRevision: action.revision,
      observedRevision: action.revision,
      ingestRevision: null,
      active,
      errorCode: null,
    };
  }
  if (action.type === "fail") {
    if (state.ingestRevision !== action.revision) return state;
    const code = action.code.trim();
    if (!code || Buffer.byteLength(code, "utf8") > 80) throw new Error("invalid preview error code");
    return { ...state, status: "error", ingestRevision: null, errorCode: code };
  }
  return {
    ...state,
    status: "deleted",
    activeRevision: action.revision,
    observedRevision: action.revision,
    ingestRevision: null,
    active: null,
    errorCode: null,
  };
}
