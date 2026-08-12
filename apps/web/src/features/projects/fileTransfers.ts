import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { api, ApiError, apiUpload } from "../../shared/api";
import { useT, type Translate } from "../../shared/i18n";
import { encodeFilePath } from "./fileLinks";

// One drag-and-drop layer for every file surface. A surface owns how it draws
// a tree; it does not own how bytes travel. Both the session Files pane and
// the project Files page mount this hook, so an upload, a move, their refusals
// and their status wording stay identical wherever an operator drops a file.

export const FILE_TREE_DRAG_TYPE = "application/x-overseer-project-file";

export type TransferEntryType = "file" | "dir";

export interface DraggedEntry {
  path: string;
  type: TransferEntryType;
  size?: number;
}

export interface DroppedFile {
  file: File;
  // Path relative to the drop target: `notes.md` for a plain file, or
  // `docs/api/notes.md` when a folder was dropped.
  relativePath: string;
}

// A row the tree can draw before the bytes exist: the operator sees what they
// dropped land where it will live, with the ring filling in place of an icon.
export interface PendingUpload {
  parent: string;
  name: string;
  type: TransferEntryType;
  total: number;
  sent: number;
}

export interface TransferStatus {
  message: string;
  busy: boolean;
  error: boolean;
}

const OS_FILE_TYPE = "Files";
const hasType = (event: DragEvent, type: string) => Array.from(event.dataTransfer.types).includes(type);
export const hasDraggedFiles = (event: DragEvent) => hasType(event, OS_FILE_TYPE);
export const hasDraggedEntry = (event: DragEvent) => hasType(event, FILE_TREE_DRAG_TYPE);

export const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const joinPath = (parent: string, name: string) => parent ? `${parent}/${name}` : name;

// A name that came from the operator's filesystem is never trusted as a path:
// separators and NULs are folded away so a dropped file can only ever land
// under the directory it was dropped on.
export const safeSegment = (name: string) => {
  const cleaned = name.replace(/[\\/\0]/g, "_");
  return !cleaned || cleaned === "." || cleaned === ".." ? "file" : cleaned;
};

export function readDraggedEntry(transfer: DataTransfer): DraggedEntry | null {
  const raw = transfer.getData(FILE_TREE_DRAG_TYPE);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { path?: unknown; type?: unknown; size?: unknown };
    if (typeof parsed.path !== "string" || !parsed.path) return null;
    return {
      path: parsed.path,
      type: parsed.type === "dir" ? "dir" : "file",
      size: typeof parsed.size === "number" ? parsed.size : undefined,
    };
  } catch {
    return null;
  }
}

export function writeDraggedEntry(transfer: DataTransfer, entry: DraggedEntry) {
  transfer.effectAllowed = "move";
  transfer.setData(FILE_TREE_DRAG_TYPE, JSON.stringify(entry));
  transfer.setData("text/plain", baseName(entry.path));
}

interface DirectoryReader {
  readEntries: (ok: (entries: FileSystemEntry[]) => void, fail: (error: unknown) => void) => void;
}
interface WalkableEntry extends FileSystemEntry {
  file?: (ok: (file: File) => void, fail: (error: unknown) => void) => void;
  createReader?: () => DirectoryReader;
}

const entryFile = (entry: WalkableEntry) => new Promise<File | null>((resolve) => {
  if (!entry.file) return resolve(null);
  entry.file((file) => resolve(file), () => resolve(null));
});

// `readEntries` returns a page at a time and signals the end with an empty
// page — a folder of 200 files would otherwise arrive truncated.
const readAll = (reader: DirectoryReader) => new Promise<FileSystemEntry[]>((resolve) => {
  const collected: FileSystemEntry[] = [];
  const next = () => reader.readEntries((page) => {
    if (page.length === 0) return resolve(collected);
    collected.push(...page);
    next();
  }, () => resolve(collected));
  next();
});

const MAX_DROPPED_FILES = 500;
const MAX_DROPPED_DEPTH = 16;

async function walkEntry(entry: WalkableEntry, prefix: string, collected: DroppedFile[], depth: number): Promise<void> {
  if (collected.length >= MAX_DROPPED_FILES || depth > MAX_DROPPED_DEPTH) return;
  const name = safeSegment(entry.name);
  if (entry.isFile) {
    const file = await entryFile(entry);
    if (file) collected.push({ file, relativePath: joinPath(prefix, name) });
    return;
  }
  if (!entry.isDirectory || !entry.createReader) return;
  for (const child of await readAll(entry.createReader())) {
    await walkEntry(child as WalkableEntry, joinPath(prefix, name), collected, depth + 1);
  }
}

// Dropped folders only exist as `webkitGetAsEntry` entries; `dataTransfer.files`
// reports a directory as a zero-byte file. The entries must be taken while the
// drop event is still being dispatched, before any await — the item list is
// emptied as soon as the handler yields.
export function takeDroppedEntries(transfer: DataTransfer): { entries: WalkableEntry[]; files: File[] } {
  const entries: WalkableEntry[] = [];
  for (const item of Array.from(transfer.items ?? [])) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.() as WalkableEntry | null;
    if (entry) entries.push(entry);
  }
  return { entries, files: Array.from(transfer.files ?? []) };
}

export async function collectDroppedFiles(taken: { entries: WalkableEntry[]; files: File[] }): Promise<DroppedFile[]> {
  if (taken.entries.length === 0) {
    return taken.files.map((file) => ({ file, relativePath: safeSegment(file.name) }));
  }
  const collected: DroppedFile[] = [];
  for (const entry of taken.entries) await walkEntry(entry, "", collected, 0);
  return collected;
}

// The file picker is the keyboard-and-mouse road to the same upload. A folder
// pick reports its tree in `webkitRelativePath`; a plain pick leaves it empty.
export function filesFromInput(files: FileList | null): DroppedFile[] {
  return Array.from(files ?? []).map((file) => {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    const segments = (relative || file.name).split("/").filter((segment) => segment !== "");
    return { file, relativePath: segments.map(safeSegment).join("/") || safeSegment(file.name) };
  });
}

// What the operator dropped, seen from the target directory: one row per
// immediate child. A whole folder is one row carrying every byte under it.
export function pendingRows(target: string, dropped: DroppedFile[]): PendingUpload[] {
  const rows = new Map<string, PendingUpload>();
  for (const item of dropped) {
    const name = item.relativePath.split("/")[0]!;
    const existing = rows.get(name);
    if (existing) {
      existing.total += item.file.size;
      existing.type = "dir";
      continue;
    }
    rows.set(name, { parent: target, name, type: item.relativePath.includes("/") ? "dir" : "file", total: item.file.size, sent: 0 });
  }
  return [...rows.values()];
}

function transferFailure(error: unknown, t: Translate, unsupported: string, failed: string): string {
  if (error instanceof ApiError && (error.status === 404 || error.status === 405)) return t(unsupported);
  return error instanceof Error && error.message ? error.message : t(failed);
}

export interface FileTransfersOptions {
  filesBase: string;
  enabled: boolean;
  // A file landed in `parent`. The surface may show it before its next listing.
  onUploaded?: (parent: string, name: string, size: number) => void;
  // Something the surface cannot predict changed under `path` — a dropped
  // folder created directories, a move rewrote two listings.
  onDirectoryChanged?: (path: string) => void;
  onMoved?: (source: string, destination: string, entry: DraggedEntry) => void;
  onDeleted?: (path: string) => void;
}

export function useFileTransfers({ filesBase, enabled, onUploaded, onDirectoryChanged, onMoved, onDeleted }: FileTransfersOptions) {
  const t = useT();
  const [status, setStatus] = useState<TransferStatus | null>(null);
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragSource, setDragSource] = useState<DraggedEntry | null>(null);
  const running = useRef(false);
  const noticeTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
  }, []);

  const settle = useCallback((next: TransferStatus) => {
    setStatus(next);
    if (next.error) return;
    noticeTimer.current = window.setTimeout(() => setStatus(null), 1600);
  }, []);

  const begin = useCallback(() => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setDropTarget(null);
  }, []);

  const upload = useCallback(async (target: string, dropped: DroppedFile[]) => {
    if (!enabled || dropped.length === 0 || running.current) return;
    running.current = true;
    begin();
    let error: string | undefined;
    let nested = false;
    // Every row shows up at once, in the place it will occupy, and fills as
    // its own bytes go out — not as the queue advances past it.
    const rows = pendingRows(target, dropped);
    const sentPerRow = new Map(rows.map((row) => [row.name, 0]));
    setPending(rows);
    try {
      for (let index = 0; index < dropped.length; index++) {
        const { file, relativePath } = dropped[index]!;
        setStatus({ message: t("proj.files.uploading", { done: index, total: dropped.length }), busy: true, error: false });
        const destination = joinPath(target, relativePath);
        const parents = relativePath.includes("/");
        const row = relativePath.split("/")[0]!;
        const before = sentPerRow.get(row) ?? 0;
        nested ||= parents;
        try {
          await apiUpload(`${filesBase}/${encodeFilePath(destination)}${parents ? "?parents=1" : ""}`, file, {
            headers: { "content-type": "application/octet-stream" },
            onProgress: (loaded) => setPending((current) => current.map((item) => item.name === row && item.parent === target ? { ...item, sent: before + loaded } : item)),
          });
          if (!parents) onUploaded?.(target, relativePath, file.size);
        } catch (uploadError) {
          error = `${file.name}: ${transferFailure(uploadError, t, "proj.files.uploadUnsupported", "proj.files.uploadFailed")}`;
        }
        sentPerRow.set(row, before + file.size);
        // The row stays until the listing that replaces it is in hand: for a
        // plain file that is the optimistic insert above, for a folder it is
        // the refresh below.
        if (!parents) setPending((current) => current.filter((item) => !(item.name === row && item.parent === target)));
      }
    } finally {
      running.current = false;
    }
    if (nested) onDirectoryChanged?.(target);
    setPending([]);
    settle(error
      ? { message: error, busy: false, error: true }
      : { message: t("proj.files.uploaded", { n: dropped.length }), busy: false, error: false });
  }, [begin, enabled, filesBase, onDirectoryChanged, onUploaded, settle, t]);

  const move = useCallback(async (entry: DraggedEntry, target: string) => {
    const source = entry.path;
    // Dropping something back where it already lives, or onto itself or one of
    // its own descendants, is a no-op rather than a refusal.
    const intoItself = entry.type === "dir" && (target === source || target.startsWith(`${source}/`));
    if (!enabled || running.current || parentPath(source) === target || intoItself) {
      setDropTarget(null);
      setDragSource(null);
      return;
    }
    running.current = true;
    begin();
    const destination = joinPath(target, baseName(source));
    setStatus({ message: t("proj.files.moving"), busy: true, error: false });
    try {
      await api(`${filesBase}/${encodeFilePath(source)}`, { method: "PATCH", body: JSON.stringify({ destination }) });
      onMoved?.(source, destination, entry);
      settle({ message: t("proj.files.moved"), busy: false, error: false });
    } catch (moveError) {
      settle({ message: transferFailure(moveError, t, "proj.files.moveUnsupported", "proj.files.moveFailed"), busy: false, error: true });
    } finally {
      running.current = false;
      setDragSource(null);
    }
  }, [begin, enabled, filesBase, onMoved, settle, t]);

  // Deleting is the one transfer with no gesture behind it: the caller has
  // already asked the operator to confirm, so this only reports whether the
  // file is gone and leaves the dialog to close itself.
  const remove = useCallback(async (path: string) => {
    if (!enabled || running.current) return false;
    running.current = true;
    begin();
    setStatus({ message: t("proj.files.deleting"), busy: true, error: false });
    try {
      await api(`${filesBase}/${encodeFilePath(path)}`, { method: "DELETE" });
      onDeleted?.(path);
      settle({ message: t("proj.files.deleted"), busy: false, error: false });
      return true;
    } catch (deleteError) {
      settle({ message: transferFailure(deleteError, t, "proj.files.deleteUnsupported", "proj.files.deleteFailed"), busy: false, error: true });
      return false;
    } finally {
      running.current = false;
    }
  }, [begin, enabled, filesBase, onDeleted, settle, t]);

  const acceptDrag = useCallback((event: DragEvent, target: string) => {
    if (!enabled || (!hasDraggedFiles(event) && !hasDraggedEntry(event))) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = hasDraggedEntry(event) ? "move" : "copy";
    setDropTarget(target);
  }, [enabled]);

  const dropZoneProps = useCallback((target: string) => ({
    onDragEnter: (event: DragEvent) => acceptDrag(event, target),
    onDragOver: (event: DragEvent) => acceptDrag(event, target),
    onDragLeave: (event: DragEvent) => {
      event.stopPropagation();
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
    },
    onDrop: (event: DragEvent) => {
      acceptDrag(event, target);
      const dragged = readDraggedEntry(event.dataTransfer);
      if (dragged) return void move(dragged, target);
      const taken = takeDroppedEntries(event.dataTransfer);
      void collectDroppedFiles(taken).then((dropped) => upload(target, dropped));
    },
  }), [acceptDrag, move, upload]);

  const dragHandleProps = useCallback((entry: DraggedEntry) => ({
    draggable: enabled,
    onDragStart: (event: DragEvent) => {
      writeDraggedEntry(event.dataTransfer, entry);
      setDragSource(entry);
    },
    onDragEnd: () => {
      setDragSource(null);
      setDropTarget(null);
    },
  }), [enabled]);

  return { status, pending, dropTarget, dragSource, dropZoneProps, dragHandleProps, upload, remove };
}
