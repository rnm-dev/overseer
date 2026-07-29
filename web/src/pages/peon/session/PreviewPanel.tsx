import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy } from "lucide-react";
import { ApiError } from "../../../api";
import type { Translate } from "../../../i18n";
import { HighlightedCode, Markdown, languageForPath } from "../../../components/RichText";
import { fileApiPath } from "../fileLinks";

export interface PreviewTarget {
  path: string;
  author?: string;
  createdAt?: number;
}

interface FileView {
  path: string;
  size: number;
  mtimeMs: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdown", "mkd", "mdx"]);

function extension(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function displayName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function errorFrom(res: Response): Promise<ApiError> {
  try {
    const body = await res.json() as { code?: string; error?: string };
    return new ApiError(res.status, body.code ?? "ERROR", body.error ?? res.statusText);
  } catch {
    return new ApiError(res.status, "ERROR", res.statusText || `request failed (${res.status})`);
  }
}

async function authorizedFetch(path: string, signal?: AbortSignal, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  return fetch(`/api${path}`, { ...init, headers, signal, credentials: "same-origin" });
}

function parseFrame(frame: string): { event: string | null; data: string } | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of frame.replace(/\r/g, "").split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  return event === null && data.length === 0 ? null : { event, data: data.join("\n") };
}

export function PreviewPanel({ base, sessionId, target, pinned, onPinnedChange, onClose, t }: {
  base: string;
  sessionId: string;
  target: PreviewTarget;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  onClose: () => void;
  t: Translate;
}) {
  const [file, setFile] = useState<FileView | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [webUrl, setWebUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);
  const [watchError, setWatchError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [revision, setRevision] = useState(0);
  const ext = useMemo(() => extension(target.path), [target.path]);
  const isImage = IMAGE_EXTENSIONS.has(ext);
  const isPdf = ext === "pdf";
  const isHtml = ext === "html";
  const isMarkdown = MARKDOWN_EXTENSIONS.has(ext);
  const filePath = fileApiPath({ kind: "sessionFile", base, sessionId, path: target.path });
  const rawPath = fileApiPath({ kind: "sessionFile", base, sessionId, path: target.path, raw: true });
  const webPath = `${base}/sessions/${encodeURIComponent(sessionId)}/web-preview`;
  const canCopy = !!file && !file.binary && file.content !== null;

  useEffect(() => setCopyStatus("idle"), [target.path, revision]);

  useEffect(() => {
    if (copyStatus === "idle") return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 1800);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  useEffect(() => {
    const ctrl = new AbortController();
    let nextBlobUrl: string | null = null;
    setLoading(true);
    setError(null);
    setFile(null);
    setBlobUrl(null);
    setWebUrl(null);
    void (async () => {
      try {
        const metaRes = await authorizedFetch(filePath, ctrl.signal);
        if (!metaRes.ok) throw await errorFrom(metaRes);
        const meta = await metaRes.json() as FileView;
        if (ctrl.signal.aborted) return;
        setFile(meta);
        if (isHtml) {
          const webRes = await authorizedFetch(webPath, ctrl.signal, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: target.path }),
          });
          if (!webRes.ok) throw await errorFrom(webRes);
          const preview = await webRes.json() as { url: string };
          if (!/^https:\/\/[a-f0-9]{32}\./.test(preview.url)) throw new ApiError(502, "INVALID_PREVIEW_URL", "Overseer returned an invalid preview URL");
          if (!ctrl.signal.aborted) setWebUrl(preview.url);
        } else if (isImage || isPdf) {
          const rawRes = await authorizedFetch(rawPath, ctrl.signal);
          if (!rawRes.ok) throw await errorFrom(rawRes);
          nextBlobUrl = URL.createObjectURL(await rawRes.blob());
          if (ctrl.signal.aborted) return URL.revokeObjectURL(nextBlobUrl);
          setBlobUrl(nextBlobUrl);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) setError(err instanceof ApiError ? err : new ApiError(0, "NETWORK_ERROR", err instanceof Error ? err.message : String(err)));
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    })();
    return () => {
      ctrl.abort();
      if (nextBlobUrl) URL.revokeObjectURL(nextBlobUrl);
    };
  }, [filePath, rawPath, webPath, target.path, isHtml, isImage, isPdf, revision]);

  // A fetch-based SSE reader is used because EventSource cannot attach the
  // operator session cookie. Reconnect after an ordinary EOF; a Peon `changed`
  // event invalidates both metadata/text and any raw object URL.
  useEffect(() => {
    const ctrl = new AbortController();
    const streamPath = `${base}/sessions/${encodeURIComponent(sessionId)}/file/stream?path=${encodeURIComponent(target.path)}`;
    void (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const res = await authorizedFetch(streamPath, ctrl.signal);
          if (!res.ok) throw await errorFrom(res);
          if (!res.body) throw new Error("empty file stream");
          setWatchError(null);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            buffer += value ? decoder.decode(value, { stream: !done }) : "";
            const normalized = buffer.replace(/\r\n/g, "\n");
            let boundary = normalized.indexOf("\n\n");
            if (boundary < 0) {
              buffer = normalized;
              if (done) break;
              continue;
            }
            buffer = normalized;
            while ((boundary = buffer.indexOf("\n\n")) >= 0) {
              const parsed = parseFrame(buffer.slice(0, boundary));
              buffer = buffer.slice(boundary + 2);
              if (parsed?.event === "changed") setRevision((n) => n + 1);
              if (parsed?.event === "failed") {
                try { setWatchError(String((JSON.parse(parsed.data) as { error?: unknown }).error ?? t("session.preview.watchFailed"))); }
                catch { setWatchError(parsed.data || t("session.preview.watchFailed")); }
              }
            }
            if (done) break;
          }
        } catch (err) {
          if (!ctrl.signal.aborted) setWatchError(err instanceof ApiError ? `${err.code}: ${err.message}` : t("session.preview.watchFailed"));
        }
        if (!ctrl.signal.aborted) await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    })();
    return () => ctrl.abort();
  }, [base, sessionId, target.path, t]);

  async function download() {
    try {
      const res = await authorizedFetch(rawPath);
      if (!res.ok) throw await errorFrom(res);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = displayName(target.path);
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "NETWORK_ERROR", err instanceof Error ? err.message : String(err)));
    }
  }

  async function copyContent() {
    if (!canCopy) return;
    try {
      await navigator.clipboard.writeText(file.content ?? "");
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  }

  return createPortal(
    <aside className="fixed bottom-0 right-0 top-0 z-[45] flex w-full flex-col border-l border-iron-700 bg-iron-950 shadow-2xl sm:w-[min(54rem,70vw)]">
      <header className="flex items-center gap-2 border-b border-iron-800 px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-sm font-semibold text-bone" title={target.path}>{displayName(target.path)}</div>
          <div className="truncate font-mono text-[0.68rem] text-bone-faint" title={target.path}>{target.path}</div>
        </div>
        <button type="button" aria-pressed={pinned} title={pinned ? t("session.preview.unpin") : t("session.preview.pin")} onClick={() => onPinnedChange(!pinned)} className={`rounded px-2 py-1 font-mono text-xs transition-colors hover:bg-iron-800 ${pinned ? "text-fel-bright" : "text-bone-dim"}`}>
          {pinned ? "◆" : "◇"}
        </button>
        {canCopy && (
          <button
            type="button"
            title={t(`session.preview.${copyStatus === "idle" ? "copy" : copyStatus}`)}
            aria-label={t(`session.preview.${copyStatus === "idle" ? "copy" : copyStatus}`)}
            onClick={() => void copyContent()}
            className={`rounded px-2 py-1 transition-colors hover:bg-iron-800 ${copyStatus === "copied" ? "text-fel-bright" : copyStatus === "failed" ? "text-blood" : "text-bone-dim hover:text-bone"}`}
          >
            {copyStatus === "copied" ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
          </button>
        )}
        <button type="button" title={t("session.preview.download")} onClick={download} className="rounded px-2 py-1 font-mono text-xs text-bone-dim transition-colors hover:bg-iron-800 hover:text-bone">↓</button>
        <button type="button" title={t("session.preview.close")} onClick={onClose} className="rounded px-2 py-1 font-mono text-lg leading-none text-bone-dim transition-colors hover:bg-iron-800 hover:text-bone">×</button>
      </header>
      {file && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-iron-800 px-3 py-1.5 font-mono text-[0.68rem] text-bone-faint">
          <span>{sizeLabel(file.size)}</span>
          <span>{new Date(file.mtimeMs).toLocaleString()}</span>
          {file.truncated && <span className="text-ember">{t("session.preview.truncated")}</span>}
          {watchError && <span className="text-ember">⚠ {watchError}</span>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto bg-void/40">
        {loading ? <div className="forge-spin mt-8" /> : error ? (
          <div className="m-4 rounded border border-blood/40 bg-blood/5 p-3 font-mono text-sm text-blood"><strong>{error.code}</strong>: {error.message}</div>
        ) : isHtml && webUrl ? (
          <iframe
            sandbox="allow-scripts allow-forms allow-modals allow-downloads"
            src={webUrl}
            title={displayName(target.path)}
            className="h-full min-h-[70vh] w-full border-0 bg-white"
          />
        ) : isImage && blobUrl ? (
          <div className="grid min-h-full place-items-center p-4"><img src={blobUrl} alt={displayName(target.path)} className="max-h-full max-w-full object-contain" /></div>
        ) : isPdf && blobUrl ? (
          <iframe src={blobUrl} title={displayName(target.path)} className="h-full min-h-[70vh] w-full border-0 bg-white" />
        ) : file && !file.binary && file.content !== null ? (
          isMarkdown ? <article className="mx-auto max-w-4xl p-5 text-sm leading-relaxed text-bone"><Markdown source={file.content} /></article>
            : <HighlightedCode source={file.content} language={languageForPath(target.path)} className="min-h-full rounded-none border-0" />
        ) : file ? (
          <div className="grid min-h-full place-items-center p-6 text-center">
            <div><div className="mb-3 font-mono text-sm text-bone-dim">{t("session.preview.unsupported")}</div><button type="button" onClick={download} className="btn btn-iron btn-sm">{t("session.preview.rawDownload")}</button></div>
          </div>
        ) : null}
      </div>
    </aside>,
    document.body,
  );
}
