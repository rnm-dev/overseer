import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, Folder, FolderOpen, LoaderCircle, RefreshCw, X } from "lucide-react";
import { api, ApiError, getToken } from "../../api";
import { HighlightedCode, Markdown, languageForPath } from "../../components/RichText";
import { useT } from "../../i18n";
import { FileTypeIcon } from "./FileTypeIcon";

export interface ProjectFileEntry {
  name: string;
  type?: string;
  size?: number;
  mtimeMs?: number;
}

interface DirectoryState {
  loading: boolean;
  entries: ProjectFileEntry[];
  error?: string;
}

interface FilePreview {
  path: string;
  loading?: boolean;
  text?: string;
  image?: string;
  pdf?: string;
  note?: string;
}

interface UploadState {
  done: number;
  total: number;
  target: string;
  error?: string;
}

interface MoveState {
  source: string;
  destination: string;
  running: boolean;
  error?: string;
}

const MAX_VIEW_BYTES = 1_000_000;
const TEXT_CAP = 400_000;
export const encodeProjectPath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
export const formatFileSize = (size?: number) => typeof size !== "number" ? "" : size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(0)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
const isDirectory = (entry: ProjectFileEntry) => entry.type === "dir" || entry.type === "directory";
const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path);
const isPdfPath = (path: string) => /\.pdf$/i.test(path);
const sortEntries = (entries: ProjectFileEntry[]) => [...entries].sort((a, b) => isDirectory(a) === isDirectory(b) ? a.name.localeCompare(b.name) : isDirectory(a) ? -1 : 1);
const sameEntries = (left: ProjectFileEntry[], right: ProjectFileEntry[]) => left.length === right.length && left.every((entry, index) => {
  const other = right[index];
  return !!other && entry.name === other.name && entry.type === other.type && entry.size === other.size && entry.mtimeMs === other.mtimeMs;
});
const hasDraggedFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");
const PROJECT_FILE_DRAG_TYPE = "application/x-overseer-project-file";
const hasDraggedProjectFile = (event: DragEvent) => Array.from(event.dataTransfer.types).includes(PROJECT_FILE_DRAG_TYPE);
const parentPath = (path: string) => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function ProjectFileTree({ filesBase, activePath, onOpenFile, onFileMoved, allowUpload = false, className = "" }: {
  filesBase: string;
  activePath?: string | null;
  onOpenFile: (path: string, size?: number) => void;
  onFileMoved?: (source: string, destination: string) => void;
  allowUpload?: boolean;
  className?: string;
}) {
  const t = useT();
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [dragSource, setDragSource] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [move, setMove] = useState<MoveState | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const uploadNoticeTimer = useRef<number | null>(null);

  const load = useCallback(async (path: string) => {
    setDirectories((current) => ({ ...current, [path]: { loading: true, entries: [] } }));
    try {
      const result = await api<{ entries?: ProjectFileEntry[] }>(`${filesBase}/${encodeProjectPath(path)}?stat=1`);
      setDirectories((current) => ({
        ...current,
        [path]: {
          loading: false,
          entries: sortEntries(result.entries ?? []),
        },
      }));
    } catch (error) {
      setDirectories((current) => ({
        ...current,
        [path]: { loading: false, entries: [], error: error instanceof ApiError ? error.message : t("error.loadFailed") },
      }));
    }
  }, [filesBase, t]);

  // Project files can change underneath Overseer while an agent is working.
  // Refresh only directories the operator has expanded, and do it silently so
  // the tree never collapses or flashes its initial loading skeleton.
  const refreshDirectory = useCallback(async (path: string) => {
    try {
      const result = await api<{ entries?: ProjectFileEntry[] }>(`${filesBase}/${encodeProjectPath(path)}?stat=1`);
      const entries = sortEntries(result.entries ?? []);
      setDirectories((current) => {
        const directory = current[path];
        if (!directory || directory.loading || sameEntries(directory.entries, entries)) return current;
        return { ...current, [path]: { loading: false, entries } };
      });
    } catch {
      // A transient refresh failure must not replace a usable tree with an
      // error. Explicit folder loads still surface errors normally.
    }
  }, [filesBase]);

  useEffect(() => () => {
    if (uploadNoticeTimer.current !== null) window.clearTimeout(uploadNoticeTimer.current);
  }, []);

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set([""]));
    load("");
  }, [filesBase, load]);

  const refreshExpanded = useCallback(async (manual = false) => {
    if (refreshingRef.current || (!manual && document.visibilityState === "hidden")) return;
    refreshingRef.current = true;
    if (manual) setRefreshing(true);
    try {
      await Promise.all([...expanded].map(refreshDirectory));
    } finally {
      refreshingRef.current = false;
      if (manual) setRefreshing(false);
    }
  }, [expanded, refreshDirectory]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshExpanded(), 3_000);
    const onVisibility = () => { if (document.visibilityState === "visible") void refreshExpanded(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refreshExpanded]);

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
    setExpanded((current) => new Set(current).add(path));
  };

  const uploadFiles = async (target: string, fileList: FileList) => {
    const files = Array.from(fileList);
    if (!allowUpload || files.length === 0 || (upload && upload.done < upload.total)) return;
    if (uploadNoticeTimer.current !== null) window.clearTimeout(uploadNoticeTimer.current);
    setDropTarget(null);
    setUpload({ done: 0, total: files.length, target });
    let error: string | undefined;
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      const cleaned = file.name.replace(/[\\/\0]/g, "_");
      const name = !cleaned || cleaned === "." || cleaned === ".." ? "file" : cleaned;
      const destination = target ? `${target}/${name}` : name;
      try {
        await api(`${filesBase}/${encodeProjectPath(destination)}`, {
          method: "PUT",
          body: file,
          headers: { "content-type": "application/octet-stream" },
        });
        setDirectories((current) => {
          const directory = current[target];
          if (!directory || directory.loading || directory.error) return current;
          const entries = sortEntries([...directory.entries.filter((entry) => entry.name !== name), { name, type: "file", size: file.size }]);
          return { ...current, [target]: { ...directory, entries } };
        });
      } catch (uploadError) {
        const message = uploadError instanceof ApiError && (uploadError.status === 404 || uploadError.status === 405)
          ? t("proj.files.uploadUnsupported")
          : uploadError instanceof Error ? uploadError.message : t("proj.files.uploadFailed");
        error = `${file.name}: ${message}`;
      } finally {
        setUpload({ done: index + 1, total: files.length, target, error });
      }
    }
    if (!error) uploadNoticeTimer.current = window.setTimeout(() => setUpload(null), 1600);
  };

  const moveFile = async (source: string, size: number | undefined, target: string) => {
    if (!allowUpload || parentPath(source) === target || move?.running) {
      setDropTarget(null);
      setDragSource(null);
      return;
    }
    if (uploadNoticeTimer.current !== null) window.clearTimeout(uploadNoticeTimer.current);
    const name = baseName(source);
    const destination = target ? `${target}/${name}` : name;
    setDropTarget(null);
    setMove({ source, destination, running: true });
    try {
      await api(`${filesBase}/${encodeProjectPath(source)}`, {
        method: "PATCH",
        body: JSON.stringify({ destination }),
      });
      setDirectories((current) => {
        const next = { ...current };
        const sourceParent = parentPath(source);
        const sourceDirectory = next[sourceParent];
        if (sourceDirectory && !sourceDirectory.loading && !sourceDirectory.error) {
          next[sourceParent] = { ...sourceDirectory, entries: sourceDirectory.entries.filter((entry) => entry.name !== name) };
        }
        const targetDirectory = next[target];
        if (targetDirectory && !targetDirectory.loading && !targetDirectory.error) {
          next[target] = { ...targetDirectory, entries: sortEntries([...targetDirectory.entries.filter((entry) => entry.name !== name), { name, type: "file", size }]) };
        }
        return next;
      });
      onFileMoved?.(source, destination);
      setMove({ source, destination, running: false });
      uploadNoticeTimer.current = window.setTimeout(() => setMove(null), 1600);
    } catch (moveError) {
      const message = moveError instanceof ApiError && (moveError.status === 404 || moveError.status === 405)
        ? t("proj.files.moveUnsupported")
        : moveError instanceof Error ? moveError.message : t("proj.files.moveFailed");
      setMove({ source, destination, running: false, error: message });
    } finally {
      setDragSource(null);
    }
  };

  const acceptDrag = (event: DragEvent, target: string) => {
    if (!allowUpload || (!hasDraggedFiles(event) && !hasDraggedProjectFile(event))) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = hasDraggedProjectFile(event) ? "move" : "copy";
    setDropTarget(target);
  };

  const dropInto = (event: DragEvent, target: string) => {
    acceptDrag(event, target);
    const raw = event.dataTransfer.getData(PROJECT_FILE_DRAG_TYPE);
    if (raw) {
      try {
        const item = JSON.parse(raw) as { path?: unknown; size?: unknown };
        if (typeof item.path === "string") void moveFile(item.path, typeof item.size === "number" ? item.size : undefined, target);
      } catch {
        setDropTarget(null);
      }
      return;
    }
    void uploadFiles(target, event.dataTransfer.files);
  };

  const renderDirectory = (path: string, depth: number) => {
    const state = directories[path];
    if (!state) return null;
    if (state.loading) return <FileTreeLoader depth={depth} label={t("app.loading")} />;
    if (state.error) return <div className="px-3 py-2 font-mono text-[0.68rem] text-blood" style={{ paddingLeft: 12 + depth * 16 }}>⚠ {state.error}</div>;
    if (path === "" && state.entries.length === 0) return <p className="p-3 font-mono text-xs text-bone-faint">{t("proj.files.empty")}</p>;
    return state.entries.map((entry) => {
      const fullPath = path ? `${path}/${entry.name}` : entry.name;
      const directory = isDirectory(entry);
      const open = directory && expanded.has(fullPath);
      const loading = directory && directories[fullPath]?.loading;
      return (
        <div key={fullPath}>
          <button
            type="button"
            draggable={allowUpload && !directory}
            onClick={() => directory ? void toggle(fullPath) : onOpenFile(fullPath, entry.size)}
            disabled={loading}
            onDragEnter={directory ? (event) => acceptDrag(event, fullPath) : undefined}
            onDragOver={directory ? (event) => acceptDrag(event, fullPath) : undefined}
            onDragLeave={directory ? (event) => { event.stopPropagation(); if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); } : undefined}
            onDrop={directory ? (event) => dropInto(event, fullPath) : undefined}
            onDragStart={!directory ? (event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(PROJECT_FILE_DRAG_TYPE, JSON.stringify({ path: fullPath, size: entry.size }));
              event.dataTransfer.setData("text/plain", entry.name);
              setDragSource(fullPath);
            } : undefined}
            onDragEnd={!directory ? () => { setDragSource(null); setDropTarget(null); } : undefined}
            className={`group flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left font-mono text-xs transition-[background-color,color,box-shadow,opacity] duration-150 ${dragSource === fullPath ? "opacity-40" : "opacity-100"} ${dropTarget === fullPath ? "bg-fel/20 text-bone shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-fel-deep)_85%,transparent),0_2px_10px_rgba(0,0,0,0.18)]" : activePath === fullPath ? "bg-iron-800 text-fel-bright" : "text-bone-dim hover:bg-iron-800/85 hover:text-bone"}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            title={fullPath}
          >
            {directory ? <ChevronRight size={13} className={`flex-none text-bone-faint transition-[transform,color] group-hover:text-bone-dim ${open ? "rotate-90" : ""}`} aria-hidden /> : <span className="w-[13px] flex-none" />}
            {directory ? (loading ? <LoaderCircle size={15} className="flex-none animate-spin text-fel-bright" aria-hidden /> : open ? <FolderOpen size={15} className="flex-none text-fel-deep transition-colors group-hover:text-fel-bright" aria-hidden /> : <Folder size={15} className="flex-none text-fel-deep transition-colors group-hover:text-fel-bright" aria-hidden />) : <FileTypeIcon name={entry.name} className="transition-[color,filter] group-hover:brightness-125" />}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {!directory && entry.size !== undefined && <span className="flex-none text-[0.62rem] text-bone-faint">{formatFileSize(entry.size)}</span>}
          </button>
          {open && renderDirectory(fullPath, depth + 1)}
        </div>
      );
    });
  };

  return (
    <div
      className={`group/file-tree relative flex min-h-0 flex-col rounded-xl transition-[background-color,box-shadow] duration-150 ${dropTarget === "" ? "bg-fel/[0.06] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-fel-deep)_75%,transparent)]" : ""} ${className}`}
      onDragEnter={(event) => acceptDrag(event, "")}
      onDragOver={(event) => acceptDrag(event, "")}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null); }}
      onDrop={(event) => dropInto(event, "")}
    >
      <button
        type="button"
        onClick={() => void refreshExpanded(true)}
        disabled={refreshing}
        className="absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-md bg-iron-950/85 text-bone-faint opacity-70 shadow-sm backdrop-blur transition-[opacity,color,background-color] hover:bg-iron-800 hover:text-fel-bright hover:opacity-100 focus-visible:opacity-100 disabled:cursor-wait"
        title={t("proj.files.refresh")}
        aria-label={t("proj.files.refresh")}
      >
        <RefreshCw size={14} className={refreshing ? "animate-spin" : ""} aria-hidden />
      </button>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">{renderDirectory("", 0)}</div>
      {dropTarget === "" && <div className="pointer-events-none absolute inset-x-3 bottom-3 rounded-lg bg-iron-950/95 px-3 py-2 text-center font-mono text-xs text-fel-bright shadow-lg">{dragSource ? t("proj.files.moveRoot") : t("proj.files.dropRoot")}</div>}
      {upload && (
        <div className={`flex flex-none items-center gap-2 bg-black/10 px-3 py-2 font-mono text-[0.68rem] ${upload.error ? "text-blood" : "text-bone-faint"}`} title={upload.error}>
          {upload.done < upload.total && <LoaderCircle size={13} className="flex-none animate-spin text-fel-deep" aria-hidden />}
          <span className="truncate">{upload.error || (upload.done < upload.total ? t("proj.files.uploading", { done: upload.done, total: upload.total }) : t("proj.files.uploaded", { n: upload.total }))}</span>
        </div>
      )}
      {move && (
        <div className={`flex flex-none items-center gap-2 bg-black/10 px-3 py-2 font-mono text-[0.68rem] ${move.error ? "text-blood" : "text-bone-faint"}`} title={move.error}>
          {move.running && <LoaderCircle size={13} className="flex-none animate-spin text-fel-deep" aria-hidden />}
          <span className="truncate">{move.error || (move.running ? t("proj.files.moving") : t("proj.files.moved"))}</span>
        </div>
      )}
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
          <span className="h-2.5 w-2.5 flex-none animate-pulse rounded-sm bg-iron-700/70" style={{ animationDelay: `${index * 90}ms` }} />
          <span className="h-2.5 animate-pulse rounded-full bg-iron-700/70" style={{ width, animationDelay: `${index * 90}ms` }} />
        </div>
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function ProjectFilePreviewModal({ filesBase, path, size, onClose }: { filesBase: string; path: string; size?: number; onClose: () => void }) {
  const t = useT();
  const [preview, setPreview] = useState<FilePreview>({ path, loading: true });
  const imageUrl = useRef<string | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    if (!isImagePath(path) && !isPdfPath(path) && typeof size === "number" && size > MAX_VIEW_BYTES) {
      setPreview({ path, note: t("proj.files.tooLarge", { size: formatFileSize(size) }) });
      return () => ctrl.abort();
    }
    const token = getToken();
    fetch(`/api${filesBase}/${encodeProjectPath(path)}`, { signal: ctrl.signal, headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("error.loadFailed"));
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/pdf") || isPdfPath(path)) {
          const url = URL.createObjectURL(await response.blob());
          imageUrl.current = url;
          setPreview({ path, pdf: url });
        } else if (contentType.startsWith("image/") || isImagePath(path)) {
          const url = URL.createObjectURL(await response.blob());
          imageUrl.current = url;
          setPreview({ path, image: url });
        } else {
          const raw = await response.text();
          setPreview({ path, text: raw.length > TEXT_CAP ? `${raw.slice(0, TEXT_CAP)}\n\n…truncated…` : raw });
        }
      })
      .catch((error) => { if (!ctrl.signal.aborted) setPreview({ path, note: error instanceof Error ? error.message : t("error.loadFailed") }); });
    return () => {
      ctrl.abort();
      if (imageUrl.current) URL.revokeObjectURL(imageUrl.current);
    };
  }, [filesBase, path, size, t]);

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4 backdrop-blur-sm" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section role="dialog" aria-modal="true" aria-label={path} className="flex h-[min(85vh,56rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl bg-iron-950 shadow-2xl">
        <header className="flex items-center gap-3 border-b border-iron-800 px-4 py-3">
          <FileTypeIcon name={path} size={16} />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-bone-dim" title={path}>{path}</span>
          <button type="button" onClick={onClose} className="rounded p-1 text-bone-faint hover:bg-iron-800 hover:text-bone" aria-label={t("session.preview.close")}><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {preview.loading ? <div className="grid h-full place-items-center"><div className="forge-spin" /></div>
            : preview.note ? <div className="grid h-full place-items-center p-6 font-mono text-xs text-bone-faint">{preview.note}</div>
              : preview.pdf ? <iframe src={preview.pdf} title={path} className="h-full min-h-[32rem] w-full border-0 bg-white" />
              : preview.image ? <div className="grid min-h-full place-items-center p-5"><img src={preview.image} alt="" className="max-h-full max-w-full rounded" /></div>
                : languageForPath(path) === "markdown" ? <article className="mx-auto max-w-4xl p-6 text-sm leading-relaxed text-bone"><Markdown source={preview.text ?? ""} /></article>
                  : <HighlightedCode source={preview.text ?? ""} language={languageForPath(path)} className="min-h-full rounded-none border-0" />}
        </div>
      </section>
    </div>,
    document.body,
  );
}
