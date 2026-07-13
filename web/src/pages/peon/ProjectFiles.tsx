import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronRight, File, Folder, FolderOpen, LoaderCircle, X } from "lucide-react";
import { api, ApiError, getToken } from "../../api";
import { HighlightedCode, Markdown, languageForPath } from "../../components/RichText";
import { useT } from "../../i18n";

export interface ProjectFileEntry {
  name: string;
  type?: string;
  size?: number;
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
  note?: string;
}

const MAX_VIEW_BYTES = 1_000_000;
const TEXT_CAP = 400_000;
export const encodeProjectPath = (path: string) => path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
export const formatFileSize = (size?: number) => typeof size !== "number" ? "" : size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(0)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
const isDirectory = (entry: ProjectFileEntry) => entry.type === "dir" || entry.type === "directory";
const isImagePath = (path: string) => /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(path);

export function ProjectFileTree({ filesBase, activePath, onOpenFile, className = "" }: {
  filesBase: string;
  activePath?: string | null;
  onOpenFile: (path: string, size?: number) => void;
  className?: string;
}) {
  const t = useT();
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([""]));

  const load = useCallback(async (path: string) => {
    setDirectories((current) => ({ ...current, [path]: { loading: true, entries: [] } }));
    try {
      const result = await api<{ entries?: ProjectFileEntry[] }>(`${filesBase}/${encodeProjectPath(path)}?stat=1`);
      setDirectories((current) => ({
        ...current,
        [path]: {
          loading: false,
          entries: [...(result.entries ?? [])].sort((a, b) => isDirectory(a) === isDirectory(b) ? a.name.localeCompare(b.name) : isDirectory(a) ? -1 : 1),
        },
      }));
    } catch (error) {
      setDirectories((current) => ({
        ...current,
        [path]: { loading: false, entries: [], error: error instanceof ApiError ? error.message : t("error.loadFailed") },
      }));
    }
  }, [filesBase, t]);

  useEffect(() => {
    setDirectories({});
    setExpanded(new Set([""]));
    load("");
  }, [filesBase, load]);

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
            onClick={() => directory ? void toggle(fullPath) : onOpenFile(fullPath, entry.size)}
            disabled={loading}
            className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left font-mono text-xs transition-colors hover:bg-black/10 ${activePath === fullPath ? "bg-black/15 text-fel-bright" : "text-bone-dim"}`}
            style={{ paddingLeft: 8 + depth * 16 }}
            title={fullPath}
          >
            {directory ? <ChevronRight size={13} className={`flex-none text-bone-faint transition-transform ${open ? "rotate-90" : ""}`} aria-hidden /> : <span className="w-[13px] flex-none" />}
            {directory ? (loading ? <LoaderCircle size={15} className="flex-none animate-spin text-fel-deep" aria-hidden /> : open ? <FolderOpen size={15} className="flex-none text-fel-deep" aria-hidden /> : <Folder size={15} className="flex-none text-fel-deep" aria-hidden />) : <File size={14} className="flex-none text-bone-faint" aria-hidden />}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {!directory && entry.size !== undefined && <span className="flex-none text-[0.62rem] text-bone-faint">{formatFileSize(entry.size)}</span>}
          </button>
          {open && renderDirectory(fullPath, depth + 1)}
        </div>
      );
    });
  };

  return <div className={`min-h-0 overflow-y-auto p-1.5 ${className}`}>{renderDirectory("", 0)}</div>;
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
    if (!isImagePath(path) && typeof size === "number" && size > MAX_VIEW_BYTES) {
      setPreview({ path, note: t("proj.files.tooLarge", { size: formatFileSize(size) }) });
      return () => ctrl.abort();
    }
    const token = getToken();
    fetch(`/api${filesBase}/${encodeProjectPath(path)}`, { signal: ctrl.signal, headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then(async (response) => {
        if (!response.ok) throw new Error(t("error.loadFailed"));
        const contentType = response.headers.get("content-type") || "";
        if (contentType.startsWith("image/") || isImagePath(path)) {
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
          <File size={16} className="flex-none text-bone-faint" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-bone-dim" title={path}>{path}</span>
          <button type="button" onClick={onClose} className="rounded p-1 text-bone-faint hover:bg-iron-800 hover:text-bone" aria-label={t("session.preview.close")}><X size={18} /></button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">
          {preview.loading ? <div className="grid h-full place-items-center"><div className="forge-spin" /></div>
            : preview.note ? <div className="grid h-full place-items-center p-6 font-mono text-xs text-bone-faint">{preview.note}</div>
              : preview.image ? <div className="grid min-h-full place-items-center p-5"><img src={preview.image} alt="" className="max-h-full max-w-full rounded" /></div>
                : languageForPath(path) === "markdown" ? <article className="mx-auto max-w-4xl p-6 text-sm leading-relaxed text-bone"><Markdown source={preview.text ?? ""} /></article>
                  : <HighlightedCode source={preview.text ?? ""} language={languageForPath(path)} className="min-h-full rounded-none border-0" />}
        </div>
      </section>
    </div>,
    document.body,
  );
}
