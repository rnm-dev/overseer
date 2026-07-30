import path from "node:path";
import { PeonOperationChannel, PeonOperationError, type PeonOperationChannelOptions, type PeonOperationFrame, type PeonOperationProtocol } from "./peonOperationChannel.js";

export const FOLDER_LISTING_CAPABILITY = "folder-listing-v1";
export const FOLDER_LISTING_ENTRY_METADATA = "entry-metadata-v1";
export const FOLDER_LISTING_ENTRY_METADATA_FEATURE = `${FOLDER_LISTING_CAPABILITY}:${FOLDER_LISTING_ENTRY_METADATA}`;
const MAX_PAGE_BYTES = 900 * 1024;
const MAX_ENTRIES = 20_000;
const MAX_LISTING_BYTES = 16 * 1024 * 1024;
const MAX_LIMIT = 500;

const PEON_ERROR_CODES = new Set([
  "BAD_REQUEST", "BAD_CURSOR", "SYNC_IN_PROGRESS", "UNKNOWN_PROJECT", "NOT_FOUND", "NOT_DIRECTORY",
  "FORBIDDEN", "INVALID_PATH", "PATH_ESCAPE", "UNSUPPORTED_PLATFORM", "LISTING_TOO_LARGE", "INTERNAL",
]);

export interface FolderListInput {
  projectId?: string;
  path?: string;
  relativePath?: string;
  limit?: number;
}

export interface FolderListEntry {
  name: string;
  type: "directory" | "file" | "other";
  size: number | null;
  mtimeMs: number | null;
}

export interface FolderListResult {
  path: string;
  projectId: string | null;
  entries: FolderListEntry[];
}

interface FolderListState {
  input: FolderListInput;
  path: string | null;
  projectId: string | null | undefined;
  entries: FolderListEntry[];
  bytes: number;
  cursors: Set<string>;
}

function operationError(message: string): PeonOperationError {
  return new PeonOperationError("PROTOCOL_ERROR", message, 502);
}

function hasOnlyKeys(frame: PeonOperationFrame, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(frame).every((key) => keys.has(key));
}

function isCancellationAcknowledgement(frame: PeonOperationFrame): boolean {
  return frame.type === "folder_list_cancelled"
    && hasOnlyKeys(frame, ["type", "requestId"]);
}

function absolutePath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

function normalizeInput(input: FolderListInput): FolderListInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PeonOperationError("BAD_REQUEST", "folder selector is required", 400);
  }
  if (Object.keys(input).some((key) => key !== "projectId" && key !== "path" && key !== "relativePath" && key !== "limit")) {
    throw new PeonOperationError("BAD_REQUEST", "folder selector contains unsupported fields", 400);
  }
  if (input.projectId !== undefined
    && (typeof input.projectId !== "string" || !input.projectId || input.projectId.length > 512 || input.projectId.includes("\0"))) {
    throw new PeonOperationError("BAD_REQUEST", "projectId must be a non-empty string", 400);
  }
  if (input.path !== undefined) {
    if (typeof input.path !== "string" || !input.path || input.path.length > 16_384 || input.path.includes("\0") || !absolutePath(input.path)) {
      throw new PeonOperationError("INVALID_PATH", "path must be absolute", 400);
    }
    if (input.relativePath !== undefined) {
      throw new PeonOperationError("BAD_REQUEST", "relativePath requires projectId without path", 400);
    }
  } else if (input.projectId === undefined) {
    throw new PeonOperationError("BAD_REQUEST", "an absolute path or projectId is required", 400);
  }
  if (input.relativePath !== undefined
    && (typeof input.relativePath !== "string" || input.relativePath.length > 16_384 || input.relativePath.includes("\0")
      || absolutePath(input.relativePath))) {
    throw new PeonOperationError("INVALID_PATH", "relativePath must stay relative to the project root", 400);
  }
  if (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isSafeInteger(input.limit) || input.limit <= 0)) {
    throw new PeonOperationError("BAD_REQUEST", "limit must be a positive integer", 400);
  }
  return {
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.relativePath === undefined ? {} : { relativePath: input.relativePath }),
    ...(input.limit === undefined ? {} : { limit: Math.min(input.limit, MAX_LIMIT) }),
  };
}

function parseEntry(value: unknown): FolderListEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw operationError("invalid folder listing entry");
  const entry = value as Record<string, unknown>;
  if (Object.keys(entry).some((key) => key !== "name" && key !== "type" && key !== "size" && key !== "mtimeMs")
    || typeof entry.name !== "string" || !entry.name || entry.name.length > 4_096 || entry.name.includes("\0")
    || (entry.type !== "directory" && entry.type !== "file" && entry.type !== "other")) {
    throw operationError("invalid folder listing entry");
  }
  const legacy = entry.size === undefined && entry.mtimeMs === undefined;
  if (!legacy) {
    const validSize = entry.type === "directory"
      ? entry.size === null
      : entry.type === "file"
        ? typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0
        : entry.size === null;
    const validMtime = entry.type === "other"
      ? entry.mtimeMs === null
      : typeof entry.mtimeMs === "number" && Number.isFinite(entry.mtimeMs);
    if (!validSize || !validMtime) {
      throw operationError("invalid folder listing entry metadata");
    }
  }
  if (legacy && entry.type === "other") throw operationError("legacy folder listing cannot contain other entries");
  return {
    name: entry.name,
    type: entry.type,
    size: legacy ? null : entry.size as number | null,
    mtimeMs: legacy ? null : entry.mtimeMs as number | null,
  };
}

function peonError(frame: PeonOperationFrame): PeonOperationError {
  if (typeof frame.code !== "string" || !PEON_ERROR_CODES.has(frame.code)
    || typeof frame.error !== "string" || !frame.error || frame.error.length > 2_000) {
    return operationError("invalid folder listing error");
  }
  const status = frame.code === "FORBIDDEN" ? 403
    : frame.code === "NOT_FOUND" || frame.code === "UNKNOWN_PROJECT" ? 404
      : frame.code === "SYNC_IN_PROGRESS" ? 409
        : frame.code === "UNSUPPORTED_PLATFORM" ? 501
        : frame.code === "INTERNAL" ? 502 : 400;
  return new PeonOperationError(frame.code, frame.error, status);
}

const folderListingProtocol: PeonOperationProtocol<FolderListInput, FolderListState, FolderListResult> = {
  capability: FOLDER_LISTING_CAPABILITY,
  handles: (frame) => frame.type === "folder_list_page" || frame.type === "folder_list_error" || frame.type === "folder_list_cancelled",
  start: (requestId, input) => {
    const normalized = normalizeInput(input);
    return {
      frame: { type: "folder_list_request", requestId, ...normalized },
      state: {
        input: normalized,
        path: null,
        projectId: input.path !== undefined ? null : undefined,
        entries: [],
        bytes: 2,
        cursors: new Set(),
      },
    };
  },
  receive: (requestId, state, frame, frameBytes) => {
    if (frame.type === "folder_list_error") {
      if (!hasOnlyKeys(frame, ["type", "requestId", "code", "error"])) throw operationError("invalid folder listing error");
      throw peonError(frame);
    }
    if (frame.type === "folder_list_cancelled") {
      if (!isCancellationAcknowledgement(frame)) throw operationError("invalid folder listing cancellation acknowledgement");
      throw new PeonOperationError("CANCELLED", "Peon cancelled the folder listing", 499);
    }
    if (frame.type !== "folder_list_page" || frameBytes > MAX_PAGE_BYTES) {
      throw operationError("folder listing page exceeds the protocol limit");
    }
    if (!hasOnlyKeys(frame, ["type", "requestId", "path", "projectId", "entries", "nextCursor", "hasMore"])) {
      throw operationError("invalid folder listing page");
    }
    if (typeof frame.path !== "string" || !frame.path || !absolutePath(frame.path)
      || (frame.projectId !== null && typeof frame.projectId !== "string")
      || !Array.isArray(frame.entries) || typeof frame.hasMore !== "boolean") {
      throw operationError("invalid folder listing page");
    }
    if (state.path === null) {
      if (state.input.path !== undefined && frame.projectId !== null) throw operationError("absolute-path listing returned a project ID");
      if (state.input.path === undefined && frame.projectId !== state.input.projectId) throw operationError("project listing returned a different project ID");
      state.path = frame.path;
      state.projectId = frame.projectId;
    } else if (frame.path !== state.path || frame.projectId !== state.projectId) {
      throw operationError("folder listing identity changed between pages");
    }

    const entries = frame.entries.map(parseEntry);
    const bytes = state.bytes + entries.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), "utf8") + 1, 0);
    if (state.entries.length + entries.length > MAX_ENTRIES || bytes > MAX_LISTING_BYTES) {
      throw new PeonOperationError("LISTING_TOO_LARGE", "folder listing exceeds local bounds", 502);
    }
    const nextCursor = frame.nextCursor;
    if (frame.hasMore) {
      if (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 2_000 || state.cursors.has(nextCursor)) {
        throw operationError("invalid or repeated folder listing cursor");
      }
      state.cursors.add(nextCursor);
      state.entries.push(...entries);
      state.bytes = bytes;
      return {
        done: false,
        state,
        next: {
          type: "folder_list_request", requestId, cursor: nextCursor,
          ...(state.input.limit === undefined ? {} : { limit: state.input.limit }),
        },
      };
    }
    if (nextCursor !== null) throw operationError("final folder listing page must have a null cursor");
    return {
      done: true,
      result: { path: state.path, projectId: state.projectId ?? null, entries: [...state.entries, ...entries] },
    };
  },
  cancel: (requestId) => ({ type: "folder_list_cancel", requestId }),
  isCancellationAcknowledgement,
};

export function createFolderListingOperations(options: PeonOperationChannelOptions = {}) {
  return new PeonOperationChannel(folderListingProtocol, options);
}

export const folderListingOperations = createFolderListingOperations();

export function listFolder(peonId: string, input: FolderListInput, signal?: AbortSignal): Promise<FolderListResult> {
  return folderListingOperations.request(peonId, input, signal);
}
