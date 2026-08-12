import { useEffect, useState } from "react";
import { Download, Maximize2, ZoomIn, ZoomOut } from "lucide-react";
import { HighlightedCode, Markdown, languageForPath } from "../../shared/RichText";
import { useT, type Translate } from "../../shared/i18n";
import { fileDownloadUrl, fileKind, fileName, fileUrl, formatFileSize, isUnviewableFile, type FileKind, type FileSource } from "./fileLinks";
import { canZoom, fitScale, nextZoom, zoomLabel, type Size } from "./imageZoom";

// One reader and one renderer for every file the app displays. The surfaces
// differ only in chrome — a modal, a side pane, a dialog — so the fetching,
// the size caps, the type decision and the failure text all live here rather
// than being reimplemented per surface with slightly different answers.

export const MAX_VIEW_BYTES = 1_000_000;
const TEXT_CAP = 400_000;

export interface FileContent {
  path: string;
  loading: boolean;
  kind?: FileKind;
  text?: string;
  objectUrl?: string;
  note?: string;
}

// Overseer answers a refused read with a code and a sentence worth showing —
// the file is outside the Peon's file transfer sandbox, file transfer is off,
// the Peon is unreachable. Prefer it over a bare status.
async function readError(response: Response, t: Translate): Promise<string> {
  const message = await response.json().then((body: { error?: string }) => body?.error).catch(() => undefined);
  return message || t("error.loadFailed");
}

// Re-reading a file the pane is already showing must not blank it: a save
// bumps `revision`, and swapping the rendered document for a spinner and back
// reads as a flash. A different file has nothing to keep, so it loads openly.
export function keepsShownContent(current: FileContent, path: string): boolean {
  const shows = current.text !== undefined || current.objectUrl !== undefined || current.note !== undefined;
  return current.path === path && shows;
}

export function useFileContent({ source, size, hint, fallback = "unsupported", enabled = true, revision = 0 }: {
  source: FileSource;
  size?: number;
  hint?: "image" | "file";
  fallback?: "text" | "unsupported";
  enabled?: boolean;
  // Bumped by a surface that has just written the file, so the reader goes
  // back for the bytes it now knows are stale.
  revision?: number;
}): FileContent {
  const t = useT();
  const url = fileUrl(source);
  const path = source.path;
  const [content, setContent] = useState<FileContent>({ path, loading: enabled });

  useEffect(() => {
    if (!enabled) return setContent({ path, loading: false });
    const name = fileName(path);
    // An archive, an executable or a font has no rendering here, so say so
    // without reading it: the fetch could only end at the same sentence, after
    // moving the whole file across the mesh to be thrown away.
    if (isUnviewableFile(name)) {
      setContent({ path, loading: false, kind: "unsupported", note: t("session.preview.unsupported") });
      return;
    }
    // Classify by name first: media streams to an object URL regardless of
    // size, everything else is capped before a megabyte of text is pulled.
    const byName = fileKind({ name, hint, fallback });
    if (byName !== "image" && byName !== "pdf" && typeof size === "number" && size > MAX_VIEW_BYTES) {
      setContent({ path, loading: false, note: t("proj.files.tooLarge", { size: formatFileSize(size) }) });
      return;
    }
    const ctrl = new AbortController();
    let objectUrl: string | null = null;
    setContent((current) => keepsShownContent(current, path) ? current : { path, loading: true });
    fetch(url, { signal: ctrl.signal, credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return setContent({ path, loading: false, note: await readError(response, t) });
        const kind = fileKind({ name, contentType: response.headers.get("content-type") || "", hint, fallback });
        if (kind === "image" || kind === "pdf") {
          objectUrl = URL.createObjectURL(await response.blob());
          setContent({ path, loading: false, kind, objectUrl });
        } else if (kind === "unsupported") {
          setContent({ path, loading: false, kind, note: t("session.preview.unsupported") });
        } else {
          const raw = await response.text();
          setContent({ path, loading: false, kind, text: raw.length > TEXT_CAP ? `${raw.slice(0, TEXT_CAP)}\n\n…truncated…` : raw });
        }
      })
      .catch((error) => {
        if (!ctrl.signal.aborted) setContent({ path, loading: false, note: error instanceof Error ? error.message : t("error.loadFailed") });
      });
    return () => {
      ctrl.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [enabled, fallback, hint, path, revision, size, t, url]);

  return content;
}

// Saving is offered for every file, viewable or not — an anchor rather than a
// blob, so the browser streams it and the operator's session cookie rides
// along on the same origin.
export function FileDownloadButton({ source, variant = "icon", className = "" }: {
  source: FileSource;
  // A toolbar wants a button; a header bar wants a segment of itself, full
  // height and squared off against its neighbours.
  variant?: "icon" | "segment";
  className?: string;
}) {
  const t = useT();
  return (
    <a
      href={fileDownloadUrl(source)}
      download={fileName(source.path)}
      title={t("file.download")}
      aria-label={t("file.download")}
      className={`${variant === "segment"
        ? "grid h-full flex-none place-items-center border-l border-edge px-3 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink"
        : "grid h-8 w-8 flex-none place-items-center rounded-lg border border-transparent text-ink-faint transition-colors hover:border-edge-strong hover:bg-surface-hover hover:text-ink"} ${className}`}
    >
      <Download size={variant === "segment" ? 14 : 16} aria-hidden />
    </a>
  );
}

// An image fits its pane until the operator says otherwise. Fitting is a state
// of its own rather than one more zoom level, because it has to keep following
// the pane as that is resized; either way the image is drawn at one explicit
// size, centred, and scrolls when it is larger than the pane.
export function ImageView({ src, name, className = "" }: { src?: string; name: string; className?: string }) {
  const t = useT();
  const [box, setBox] = useState<Size>({ width: 0, height: 0 });
  const [natural, setNatural] = useState<Size>({ width: 0, height: 0 });
  const [scale, setScale] = useState<number | null>(null);
  const [node, setNode] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!node) return;
    // offsetWidth, not clientWidth: a scrollbar appearing while zoomed would
    // otherwise shrink the measured box, change the fit ratio, remove the
    // scrollbar and start again.
    const measure = () => setBox({ width: node.offsetWidth, height: node.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [node]);

  useEffect(() => setScale(null), [src]);

  const fitted = fitScale(natural, { width: box.width - IMAGE_PADDING, height: box.height - IMAGE_PADDING });
  const effective = scale ?? fitted;
  const measured = natural.width > 0 && box.width > 0;
  const step = (direction: 1 | -1) => setScale(nextZoom(effective, direction));

  return (
    <div className={`relative flex h-full min-h-full min-w-0 ${className}`}>
      {/* `place-content-center` rather than `place-items-center`: it centers an
          image smaller than the pane and, unlike centering with flexbox, still
          lets an overflowing one scroll to its own top-left corner. */}
      <div ref={setNode} className="grid min-h-0 w-full min-w-0 flex-1 place-content-center overflow-auto p-5">
        <img
          src={src}
          alt={name}
          onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onDoubleClick={() => setScale(scale === null ? 1 : null)}
          // Fitting and zooming are the same rendering — one explicit size,
          // differing only in where the ratio came from. Nothing depends on
          // max-width rules that a mode switch could contradict, and the pane
          // getting narrower animates exactly like a zoom step.
          className={`rounded transition-[width,height] duration-150 ease-out motion-reduce:transition-none ${measured ? "max-w-none" : "max-h-full max-w-full"}`}
          style={measured ? { width: Math.max(1, Math.round(natural.width * effective)), height: Math.max(1, Math.round(natural.height * effective)) } : undefined}
        />
      </div>
      {measured && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-0.5 rounded-lg border border-edge bg-surface/95 p-1 shadow-lg backdrop-blur">
            <button type="button" className={ZOOM_BUTTON_CLASS} onClick={() => step(-1)} disabled={!canZoom(effective, -1)} title={t("file.zoomOut")} aria-label={t("file.zoomOut")}>
              <ZoomOut size={14} aria-hidden />
            </button>
            {/* The label is the way back: one click returns to the ratio that
                is not currently in use, so it toggles fit and actual size. */}
            <button
              type="button"
              className="min-w-[3.25rem] rounded-md px-1.5 py-1 font-mono text-[0.68rem] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink"
              onClick={() => setScale(scale === null ? 1 : null)}
              title={t(scale === null ? "file.zoomActual" : "file.zoomFit")}
            >
              {zoomLabel(effective)}
            </button>
            <button type="button" className={ZOOM_BUTTON_CLASS} onClick={() => step(1)} disabled={!canZoom(effective, 1)} title={t("file.zoomIn")} aria-label={t("file.zoomIn")}>
              <ZoomIn size={14} aria-hidden />
            </button>
            <button type="button" className={ZOOM_BUTTON_CLASS} onClick={() => setScale(null)} disabled={scale === null} title={t("file.zoomFit")} aria-label={t("file.zoomFit")}>
              <Maximize2 size={14} aria-hidden />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The pane's padding is not image room, so the fit ratio must not count it.
const IMAGE_PADDING = 40;
const ZOOM_BUTTON_CLASS = "grid size-7 place-items-center rounded-md text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-ink-faint";

export function FileView({ content, className = "" }: { content: FileContent; className?: string }) {
  const t = useT();
  const { path, kind, objectUrl, text, note, loading } = content;
  if (loading) return <div className={`grid min-h-40 place-items-center ${className}`}><div className="loading-spinner" /></div>;
  if (note) return <p className={`grid min-h-full place-items-center p-6 text-center font-mono text-xs text-ink-faint ${className}`}>{note}</p>;
  if (kind === "pdf") return <iframe src={objectUrl} title={path} className={`h-full min-h-[32rem] w-full border-0 bg-white ${className}`} />;
  if (kind === "image") return <ImageView src={objectUrl} name={fileName(path)} className={className} />;
  if (kind === "markdown") return <article className={`mx-auto max-w-4xl p-6 text-sm leading-relaxed text-ink ${className}`}><Markdown source={text ?? ""} /></article>;
  if (kind === "text") return <HighlightedCode source={text ?? ""} language={languageForPath(path)} lineNumbers className={`code-view--flush min-h-full ${className}`} />;
  return <p className={`grid min-h-full place-items-center p-6 text-center font-mono text-xs text-ink-faint ${className}`}>{t("session.preview.unsupported")}</p>;
}
