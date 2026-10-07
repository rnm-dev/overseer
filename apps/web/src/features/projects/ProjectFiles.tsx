import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Check, Copy, Download, ExternalLink, Folder, FolderOpen, FolderUp, LoaderCircle, Pencil, RefreshCw, Save, Trash2, Upload, X } from "lucide-react";
import { ApiError } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { ConfirmationDialog } from "../../shared/ui";
import { CodeEditor } from "./CodeEditor";
import { canEditFile, useFileEditor } from "./fileEditing";
import { FileTypeIcon } from "./FileTypeIcon";
import { FileDownloadButton, FileView, useFileContent } from "./FileView";
import { fileDownloadUrl, fileName, fileWriteBase, formatFileSize, type FileSource } from "./fileLinks";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { baseName, filesFromInput, parentPath, useFileTransfers, type DraggedEntry, type PendingUpload } from "./fileTransfers";
import { requestProjectDirectory, refreshProjectDirectory, type ProjectFileEntry } from "./projectDirectoryListing";
import { useProjectDirectoryWatch } from "./projectDirectoryWatch";

export { formatFileSize } from "./fileLinks";

interface DirectoryState {
  loading: boolean;
  entries: ProjectFileEntry[];
  error?: string;
}

const isDirectory = (entry: ProjectFileEntry) => entry.type === "dir" || entry.type === "directory";
const sortEntries = (entries: ProjectFileEntry[]) => [...entries].sort((a, b) => isDirectory(a) === isDirectory(b) ? a.name.localeCompare(b.name) : isDirectory(a) ? -1 : 1);
const sameEntries = (left: ProjectFileEntry[], right: ProjectFileEntry[]) => left.length === right.length && left.every((entry, index) => {
  const other = right[index];
  return !!other && entry.name === other.name && entry.type === other.type && entry.size === other.size && entry.mtimeMs === other.mtimeMs;
});

// Keep a right-click menu inside the viewport wherever the pointer was: an
// entry near the bottom edge would otherwise open below the fold.
export function fileContextMenuPosition(clientX: number, clientY: number, viewportWidth: number, viewportHeight: number, itemCount: number) {
  const width = 208;
  const height = 16 + Math.max(1, itemCount) * 32;
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(clientX, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(clientY, viewportHeight - height - margin)),
  };
}

interface FileMenuState {
  path: string;
  // A folder and the empty space below the tree both offer uploads into a
  // directory; only a file offers open/download.
  kind: "file" | "dir";
  size?: number;
  x: number;
  y: number;
}

// The root has no path to copy, and a read-only tree offers no uploads — so a
// folder menu is only ever refresh plus whatever else applies. Peon deletes
// regular files only, so a folder is never offered Delete.
export function fileMenuItemCount(kind: "file" | "dir", path: string, allowUpload: boolean) {
  if (kind === "file") return 3 + (allowUpload ? 1 : 0);
  return 1 + (allowUpload ? 2 : 0) + (path ? 1 : 0);
}

export function ProjectFileTree({ peonId, projectKey, filesBase, sourceFor, activePath, onOpenFile, onFileMoved, onFileDeleted, refreshRevision = 0, allowUpload = false, className = "" }: {
  filesBase: string;
  peonId: string;
  projectKey: string;
  // How a tree path is named for reading and saving. The tree never assembles
  // a file URL itself; fileLinks.ts owns that for every surface.
  sourceFor: (path: string) => FileSource;
  activePath?: string | null;
  onOpenFile: (path: string, size?: number) => void;
  onFileMoved?: (source: string, destination: string) => void;
  onFileDeleted?: (path: string) => void;
  // Increment when files may have changed outside this tree (for example when
  // an agent turn finishes). Expanded folders are revalidated in place.
  refreshRevision?: number;
  allowUpload?: boolean;
  className?: string;
}) {
  const t = useT();
  const treeRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<FileMenuState | null>(null);
  const [copied, setCopied] = useState(false);
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const refreshingRef = useRef(false);
  const previousRefreshRevisionRef = useRef(refreshRevision);
  const requestGenerationRef = useRef(0);
  const filePicker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const pickTarget = useRef("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async (path: string) => {
    const generation = requestGenerationRef.current;
    setDirectories((current) => ({ ...current, [path]: { loading: true, entries: [] } }));
    try {
      const entries = await requestProjectDirectory(filesBase, path);
      if (generation !== requestGenerationRef.current) return;
      setDirectories((current) => ({
        ...current,
        [path]: {
          loading: false,
          entries: sortEntries(entries),
        },
      }));
    } catch (error) {
      if (generation !== requestGenerationRef.current) return;
      setDirectories((current) => ({
        ...current,
        [path]: { loading: false, entries: [], error: error instanceof ApiError ? error.message : t("error.loadFailed") },
      }));
    }
  }, [filesBase, t]);

  // A refresh updates only directories the operator has expanded and
  // does so silently, without collapsing the tree or flashing its loader.
  const refreshDirectory = useCallback(async (path: string) => {
    const generation = requestGenerationRef.current;
    try {
      const entries = sortEntries(await refreshProjectDirectory(filesBase, path));
      if (generation !== requestGenerationRef.current) return;
      setDirectories((current) => {
        const directory = current[path];
        if (!directory || directory.loading || (!directory.error && sameEntries(directory.entries, entries))) return current;
        return { ...current, [path]: { loading: false, entries } };
      });
      return true;
    } catch (error) {
      // A transient refresh failure must not replace a usable tree with an
      // error. Explicit folder loads still surface errors normally.
      return error instanceof ApiError && [400, 401, 403, 404].includes(error.status);
    }
  }, [filesBase]);

  // A listing the operator has not opened yet is left alone: it will be read
  // fresh when it is expanded, so patching it would only invent state.
  const patchDirectory = useCallback((path: string, patch: (entries: ProjectFileEntry[]) => ProjectFileEntry[]) => {
    setDirectories((current) => {
      const directory = current[path];
      if (!directory || directory.loading || directory.error) return current;
      return { ...current, [path]: { ...directory, entries: sortEntries(patch(directory.entries)) } };
    });
  }, []);

  const transfers = useFileTransfers({
    filesBase,
    enabled: allowUpload,
    onUploaded: (parent, name, size) => patchDirectory(parent, (entries) => [...entries.filter((entry) => entry.name !== name), { name, type: "file", size }]),
    onDirectoryChanged: (path) => void refreshDirectory(path),
    onMoved: (source, destination, entry) => {
      const name = baseName(destination);
      patchDirectory(parentPath(source), (entries) => entries.filter((item) => item.name !== baseName(source)));
      patchDirectory(parentPath(destination), (entries) => [...entries.filter((item) => item.name !== name), { name, type: entry.type === "dir" ? "dir" : "file", size: entry.size }]);
      // A moved folder keeps its expanded children under their old paths.
      // Dropping its cached subtree makes the next expansion read the truth.
      if (entry.type === "dir") {
        setDirectories((current) => Object.fromEntries(Object.entries(current).filter(([path]) => path !== source && !path.startsWith(`${source}/`))));
        setExpanded((current) => new Set([...current].filter((path) => path !== source && !path.startsWith(`${source}/`))));
      }
      onFileMoved?.(source, destination);
    },
    onDeleted: (path) => {
      patchDirectory(parentPath(path), (entries) => entries.filter((item) => item.name !== baseName(path)));
      onFileDeleted?.(path);
    },
  });

  useEffect(() => {
    if (!menu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    const viewport = () => setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", viewport, true);
    window.addEventListener("resize", viewport);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", viewport, true);
      window.removeEventListener("resize", viewport);
    };
  }, [menu]);

  const openMenu = (kind: "file" | "dir", path: string, size: number | undefined, x: number, y: number) => {
    const items = fileMenuItemCount(kind, path, allowUpload);
    if (items === 0) return;
    setCopied(false);
    setMenu({ path, kind, size, ...fileContextMenuPosition(x, y, window.innerWidth, window.innerHeight, items) });
  };

  const pick = (target: string, folder: boolean) => {
    pickTarget.current = target;
    setMenu(null);
    const input = folder ? folderPicker.current : filePicker.current;
    if (!input) return;
    // Picking the same file twice in a row must still fire `change`.
    input.value = "";
    input.click();
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      window.setTimeout(() => setMenu(null), 700);
    } catch {
      setMenu(null);
    }
  };

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set([""]));
    load("");
    return () => { requestGenerationRef.current += 1; };
  }, [filesBase, load]);

  const refreshExpanded = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    try {
      await Promise.all([...expanded].map(refreshDirectory));
    } finally {
      refreshingRef.current = false;
    }
  }, [expanded, refreshDirectory]);

  const watchUnavailable = useProjectDirectoryWatch(peonId, projectKey, new Set([...expanded].filter((path) => !path || directories[parentPath(path)]?.entries.some((entry) => entry.name === baseName(path) && isDirectory(entry)))), refreshDirectory, treeRef);

  useEffect(() => {
    if (previousRefreshRevisionRef.current === refreshRevision) return;
    previousRefreshRevisionRef.current = refreshRevision;
    void refreshExpanded();
  }, [refreshExpanded, refreshRevision]);

  const toggle = async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    if (!directories[path]) await load(path);
    else void refreshDirectory(path);
    setExpanded((current) => new Set(current).add(path));
  };

  const renderDirectory = (path: string, depth: number) => {
    const state = directories[path];
    if (!state) return null;
    if (state.loading) return <FileTreeLoader depth={depth} label={t("app.loading")} />;
    if (state.error) return <div className="px-3 py-2 font-mono text-[0.68rem] text-danger" style={{ paddingLeft: 12 + depth * 16 }}>⚠ {state.error}</div>;
    // An arriving upload sorts in among the real entries, so it appears where
    // it will finally live rather than at the end of the list.
    const arriving = transfers.pending.filter((row) => row.parent === path);
    const entries = sortEntries([...state.entries.filter((entry) => !arriving.some((row) => row.name === entry.name)), ...arriving.map((row) => ({ name: row.name, type: row.type, arriving: row }))] as ProjectFileEntry[]);
    if (path === "" && entries.length === 0) return <p className="p-3 font-mono text-xs text-ink-faint">{t("proj.files.empty")}</p>;
    return entries.map((entry) => {
      const arrivingRow = (entry as ProjectFileEntry & { arriving?: PendingUpload }).arriving;
      if (arrivingRow) return <ArrivingRow key={`arriving:${entry.name}`} row={arrivingRow} depth={depth} label={t("proj.files.uploadingOne", { name: entry.name })} />;
      const fullPath = path ? `${path}/${entry.name}` : entry.name;
      const directory = isDirectory(entry);
      const open = directory && expanded.has(fullPath);
      const loading = directory && directories[fullPath]?.loading;
      const dragged: DraggedEntry = { path: fullPath, type: directory ? "dir" : "file", size: entry.size };
      return (
        <div key={fullPath}>
          <button
            type="button"
            onClick={() => directory ? void toggle(fullPath) : onOpenFile(fullPath, entry.size)}
            onContextMenu={(event) => {
              event.preventDefault();
              openMenu(directory ? "dir" : "file", fullPath, entry.size, event.clientX, event.clientY);
            }}
            disabled={loading}
            // A folder both carries (it can be dragged elsewhere) and receives
            // (uploads and moves land in it); a file only carries.
            {...transfers.dragHandleProps(dragged)}
            {...(directory ? transfers.dropZoneProps(fullPath) : {})}
            className={`group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-[background-color,color,box-shadow,opacity] duration-150 ${transfers.dragSource?.path === fullPath ? "opacity-40" : "opacity-100"} ${transfers.dropTarget === fullPath ? "bg-accent/20 text-ink shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent-deep)_85%,transparent),0_2px_10px_rgba(0,0,0,0.18)]" : activePath === fullPath ? "bg-surface-hover text-accent-strong" : "text-ink-muted hover:bg-surface-hover/85 hover:text-ink"}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            title={fullPath}
          >
            {directory ? <ChevronRight size={13} className={`flex-none text-ink-faint transition-[transform,color] group-hover:text-ink-muted ${open ? "rotate-90" : ""}`} aria-hidden /> : <span className="w-[13px] flex-none" />}
            {directory ? (loading ? <LoaderCircle size={15} className="flex-none animate-spin text-accent-strong" aria-hidden /> : open ? <FolderOpen size={15} className="flex-none text-accent-deep transition-colors group-hover:text-accent-strong" aria-hidden /> : <Folder size={15} className="flex-none text-accent-deep transition-colors group-hover:text-accent-strong" aria-hidden />) : <FileTypeIcon name={entry.name} className="transition-[color,filter] group-hover:brightness-125" />}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {!directory && entry.size !== undefined && <span className="flex-none text-[0.62rem] text-ink-faint">{formatFileSize(entry.size)}</span>}
          </button>
          {open && renderDirectory(fullPath, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      ref={treeRef}
      className={`group/file-tree relative flex min-h-0 flex-col rounded-xl transition-[background-color,box-shadow] duration-150 ${transfers.dropTarget === "" ? "bg-accent/[0.06] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-accent-deep)_75%,transparent)]" : ""} ${className}`}
      {...transfers.dropZoneProps("")}
    >
      {watchUnavailable && <div role="status" className="flex items-center gap-2 px-3 py-1.5 text-xs text-ink-muted">
        <span className="flex-1">{t("proj.files.autoUnavailable")}</span>
        <button type="button" onClick={() => void refreshExpanded()}>{t("proj.files.refresh")}</button>
      </div>}
      <div
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
        // A row that opened its own menu has already claimed the event; the
        // empty space around the rows stands for the project root.
        onContextMenu={(event) => {
          if (event.defaultPrevented) return;
          event.preventDefault();
          openMenu("dir", "", undefined, event.clientX, event.clientY);
        }}
      >
        {renderDirectory("", 0)}
      </div>
      {allowUpload && <>
        <input ref={filePicker} type="file" multiple className="hidden" onChange={(event) => void transfers.upload(pickTarget.current, filesFromInput(event.target.files))} />
        {/* A directory pick is not in the React DOM typings, and every browser
            that offers one reads the attribute rather than the property. */}
        <input ref={folderPicker} type="file" multiple className="hidden" {...{ webkitdirectory: "" }} onChange={(event) => void transfers.upload(pickTarget.current, filesFromInput(event.target.files))} />
      </>}
      {transfers.dropTarget === "" && <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg bg-surface/95 px-3 py-2 text-center font-mono text-xs text-accent-strong shadow-lg">{transfers.dragSource ? t("proj.files.moveRoot") : t("proj.files.dropRoot")}</div>}
      {transfers.status && (
        <div className={`flex flex-none items-center gap-2 bg-black/10 px-3 py-2 font-mono text-[0.68rem] ${transfers.status.error ? "text-danger" : "text-ink-faint"}`} title={transfers.status.message}>
          {transfers.status.busy && <LoaderCircle size={13} className="flex-none animate-spin text-accent-deep" aria-hidden />}
          <span className="truncate">{transfers.status.message}</span>
        </div>
      )}
      {menu && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${t("file.actions")}: ${menu.path ? fileName(menu.path) : t("proj.files.root")}`}
          className="fixed z-[110] w-52 overflow-hidden rounded-lg border border-edge bg-surface py-1 shadow-xl"
          style={{ left: menu.x, top: menu.y }}
        >
          {menu.kind === "file" && <>
            <button type="button" role="menuitem" className={FILE_MENU_ITEM_CLASS} onClick={() => { setMenu(null); onOpenFile(menu.path, menu.size); }}>
              <span className="min-w-0 flex-1 truncate">{t("file.open")}</span>
              <ExternalLink size={12} className="flex-none text-ink-faint" aria-hidden />
            </button>
            <a
              role="menuitem"
              href={fileDownloadUrl(sourceFor(menu.path))}
              download={fileName(menu.path)}
              className={FILE_MENU_ITEM_CLASS}
              onClick={() => setMenu(null)}
            >
              <span className="min-w-0 flex-1 truncate">{t("file.download")}</span>
              <Download size={12} className="flex-none text-ink-faint" aria-hidden />
            </a>
          </>}
          {menu.kind === "dir" && (
            <button type="button" role="menuitem" className={FILE_MENU_ITEM_CLASS} onClick={() => { setMenu(null); void (menu.path ? refreshDirectory(menu.path) : refreshExpanded()); }}>
              <span className="min-w-0 flex-1 truncate">{t("proj.files.refresh")}</span>
              <RefreshCw size={12} className="flex-none text-ink-faint" aria-hidden />
            </button>
          )}
          {menu.kind === "dir" && allowUpload && <>
            <button type="button" role="menuitem" className={FILE_MENU_ITEM_CLASS} onClick={() => pick(menu.path, false)}>
              <span className="min-w-0 flex-1 truncate">{t("file.uploadFiles")}</span>
              <Upload size={12} className="flex-none text-ink-faint" aria-hidden />
            </button>
            <button type="button" role="menuitem" className={FILE_MENU_ITEM_CLASS} onClick={() => pick(menu.path, true)}>
              <span className="min-w-0 flex-1 truncate">{t("file.uploadFolder")}</span>
              <FolderUp size={12} className="flex-none text-ink-faint" aria-hidden />
            </button>
          </>}
          {(menu.kind === "file" || menu.path) && (
            <button type="button" role="menuitem" className={FILE_MENU_ITEM_CLASS} onClick={() => void copyPath(menu.path)}>
              <span className="min-w-0 flex-1 truncate">{t(copied ? "file.pathCopied" : "file.copyPath")}</span>
              {copied ? <Check size={12} className="flex-none text-accent-strong" aria-hidden /> : <Copy size={12} className="flex-none text-ink-faint" aria-hidden />}
            </button>
          )}
          {menu.kind === "file" && allowUpload && (
            <button type="button" role="menuitem" className={`${FILE_MENU_ITEM_CLASS} !text-danger hover:!bg-danger/10`} onClick={() => { setConfirmDelete(menu.path); setMenu(null); }}>
              <span className="min-w-0 flex-1 truncate">{t("file.delete")}</span>
              <Trash2 size={12} className="flex-none" aria-hidden />
            </button>
          )}
        </div>,
        document.body,
      )}
      {confirmDelete !== null && (
        <ConfirmationDialog
          title={t("file.deleteTitle")}
          description={t("file.deleteBody", { name: confirmDelete })}
          confirmLabel={t("file.deleteConfirm")}
          pendingLabel={t("file.deleting")}
          pending={deleting}
          onClose={() => { if (!deleting) setConfirmDelete(null); }}
          onConfirm={() => {
            const path = confirmDelete;
            setDeleting(true);
            // The dialog closes either way: a refusal is reported by the same
            // status strip an upload or a move uses.
            void transfers.remove(path).finally(() => {
              setDeleting(false);
              setConfirmDelete(null);
            });
          }}
        />
      )}
    </div>
  );
}

const FILE_MENU_ITEM_CLASS = "flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-body text-[0.7rem] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60";

// The ring stands where the file's icon will be, so a row does not change
// shape when the bytes land — it only swaps the ring for the icon.
export function UploadRing({ value }: { value: number }) {
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width={15} height={15} viewBox="0 0 15 15" className="flex-none -rotate-90" aria-hidden>
      <circle cx="7.5" cy="7.5" r={radius} fill="none" strokeWidth="2" className="stroke-surface-active" />
      <circle
        cx="7.5"
        cy="7.5"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        className="stroke-accent-strong transition-[stroke-dashoffset] duration-150"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - Math.min(1, Math.max(0, value)))}
      />
    </svg>
  );
}

function ArrivingRow({ row, depth, label }: { row: PendingUpload; depth: number; label: string }) {
  // A zero-byte file (or a browser that cannot measure the body) has no ratio
  // to show; it spins instead of pretending to be at 100%.
  const measurable = row.total > 0;
  return (
    <div
      role="status"
      aria-label={label}
      className="flex w-full animate-pulse items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-xs text-ink-faint"
      style={{ paddingLeft: 8 + depth * 16 }}
      title={label}
    >
      <span className="w-[13px] flex-none" />
      {measurable ? <UploadRing value={row.sent / row.total} /> : <LoaderCircle size={15} className="flex-none animate-spin text-accent-strong" aria-hidden />}
      <span className="min-w-0 flex-1 truncate">{row.name}</span>
      {measurable && <span className="flex-none text-[0.62rem] text-ink-faint">{formatFileSize(row.total)}</span>}
    </div>
  );
}

function FileTreeLoader({ depth, label }: { depth: number; label: string }) {
  const rows = depth === 0 ? ["68%", "52%", "76%", "44%", "61%"] : ["58%", "72%", "46%"];
  return (
    <div role="status" aria-label={label} className="space-y-0.5 py-0.5">
      {rows.map((width, index) => (
        <div
          key={`${width}-${index}`}
          className="flex h-7 items-center gap-2 rounded px-2"
          style={{ paddingLeft: 8 + depth * 16, animationDelay: `${index * 90}ms` }}
        >
          <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-sm bg-surface-active/70" style={{ animationDelay: `${index * 90}ms` }} />
          <span className="h-2.5 animate-pulse rounded-full bg-surface-active/70" style={{ width, animationDelay: `${index * 90}ms` }} />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

// A title-bar action: the same height and corner as the download and close
// buttons beside it, so the row reads as one set of controls rather than a
// button dropped into a header.
const MODAL_ACTION = "flex h-8 flex-none items-center gap-1.5 rounded-lg border border-transparent px-2.5 font-display text-[0.7rem] font-semibold text-ink-muted transition-colors hover:border-edge-strong hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:border-transparent disabled:hover:bg-transparent disabled:hover:text-ink-muted";
const MODAL_ACTION_PRIMARY = "flex h-8 flex-none items-center gap-1.5 rounded-lg border border-accent/45 bg-accent/15 px-3 font-display text-[0.7rem] font-semibold text-accent-strong transition-colors hover:border-accent/70 hover:bg-accent/25 disabled:cursor-default disabled:opacity-45 disabled:hover:border-accent/45 disabled:hover:bg-accent/15";

export function ProjectFilePreviewModal({ source, path, size, viewerUrl, writable = true, onSaved, onClose }: {
  source: FileSource;
  path: string;
  size?: number;
  // The address a transcript link was written with, kept because it carries
  // the anchor or query the plain bytes URL would drop.
  viewerUrl?: string;
  // Whether the surface that opened the modal may write this file back. The
  // gate still refuses anything the editor cannot represent, and a source with
  // no write route is never editable whatever this says.
  writable?: boolean;
  onSaved?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [revision, setRevision] = useState(0);
  // An HTML file renders as a page here the way it does in every other pane —
  // the shared renderer owns that now. A link clicked in a transcript still
  // hands over the address it was written with, so an anchor survives.
  const content = useFileContent({ source, size, fallback: "text", revision, previewUrl: viewerUrl });
  const writeBase = fileWriteBase(source);
  const editable = canEditFile(content.kind, writable && !!writeBase, content.text !== undefined);
  const editor = useFileEditor({
    filesBase: writeBase ?? "",
    path,
    original: content.text,
    originalPath: content.path,
    editable,
    // What is on disk is no longer what was read, so the viewer reads again
    // rather than rendering the draft it happens to still hold.
    onSaved: () => {
      setRevision((current) => current + 1);
      onSaved?.();
    },
  });
  // Closing the window is the one way out of this editor, so a draft has to be
  // asked about here the way the Files page asks when another file is opened.
  const [confirmClose, setConfirmClose] = useState(false);
  const requestClose = () => editor.dirty ? setConfirmClose(true) : onClose();

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-[radial-gradient(circle_at_50%_18%,rgba(149,201,103,0.08),transparent_38%),rgba(2,4,3,0.82)] p-4 backdrop-blur-md" onMouseDown={(event) => event.target === event.currentTarget && requestClose()}>
      <section role="dialog" aria-modal="true" aria-label={path} className="relative flex h-[min(88vh,56rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-edge-strong/80 bg-surface/95 shadow-[0_28px_90px_rgba(0,0,0,0.65),0_0_0_1px_rgba(149,201,103,0.04)]">
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px bg-gradient-to-r from-transparent via-accent/45 to-transparent" />
        <header className="flex items-center gap-2 border-b border-edge bg-surface-raised/70 px-4 py-3.5">
          <FileTypeIcon name={path} size={16} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-muted" title={path}>{path}</span>
          {/* Unsaved work is said in the title bar, where the operator is
              looking when they reach for the close button. */}
          {editor.dirty && <span className="flex-none rounded-full bg-warning/15 px-2 py-0.5 font-display text-[0.6rem] font-semibold uppercase tracking-[0.12em] text-warning-strong">{t("file.unsaved")}</span>}
          {editor.editing ? <>
            <button type="button" className={MODAL_ACTION} onClick={editor.close} disabled={editor.saving}>{t(editor.dirty ? "action.cancel" : "file.closeEditor")}</button>
            <button type="button" className={MODAL_ACTION_PRIMARY} title={t("file.saveShortcut")} onClick={() => void editor.save()} disabled={!editor.dirty || editor.saving}>
              {editor.saving ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <Save size={13} aria-hidden />}
              {editor.saving ? t("file.saving") : t("file.save")}
            </button>
          </> : editable && (
            <button type="button" className={MODAL_ACTION} onClick={editor.open}>
              <Pencil size={13} aria-hidden />
              {t("file.edit")}
            </button>
          )}
          <FileDownloadButton source={source} />
          <button type="button" onClick={requestClose} className="grid h-8 w-8 place-items-center rounded-lg border border-transparent text-ink-faint transition-colors hover:border-edge-strong hover:bg-surface-hover hover:text-ink" aria-label={t("session.preview.close")}><X size={18} /></button>
        </header>
        {editor.error && <p role="alert" className="flex-none border-b border-danger/35 bg-danger/10 px-4 py-2 font-mono text-[0.68rem] text-danger">{editor.error}</p>}
        <div className="min-h-0 flex-1 overflow-auto">
          {editor.editing
            ? <CodeEditor value={editor.draft ?? ""} onChange={editor.setDraft} label={path} />
            : <FileView content={content} />}
        </div>
      </section>
      {confirmClose && (
        <UnsavedChangesDialog
          name={path}
          error={editor.error}
          saving={editor.saving}
          onCancel={() => setConfirmClose(false)}
          onDiscard={() => { editor.discard(); onClose(); }}
          // A refused save keeps the question open with its error rather than
          // closing the window over the work it failed to write.
          onSave={() => void editor.save().then((saved) => saved && onClose())}
        />
      )}
    </div>,
    document.body,
  );
}
