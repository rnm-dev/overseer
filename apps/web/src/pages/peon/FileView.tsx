import { useEffect, useState } from "react";
import { HighlightedCode, Markdown, languageForPath } from "../../components/RichText";
import { useT, type Translate } from "../../i18n";
import { fileKind, fileName, fileUrl, formatFileSize, type FileKind, type FileSource } from "./fileLinks";

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

export function useFileContent({ source, size, hint, fallback = "unsupported", enabled = true }: {
  source: FileSource;
  size?: number;
  hint?: "image" | "file";
  fallback?: "text" | "unsupported";
  enabled?: boolean;
}): FileContent {
  const t = useT();
  const url = fileUrl(source);
  const path = source.path;
  const [content, setContent] = useState<FileContent>({ path, loading: enabled });

  useEffect(() => {
    if (!enabled) return setContent({ path, loading: false });
    const name = fileName(path);
    // Classify by name first: media streams to an object URL regardless of
    // size, everything else is capped before a megabyte of text is pulled.
    const byName = fileKind({ name, hint, fallback });
    if (byName !== "image" && byName !== "pdf" && typeof size === "number" && size > MAX_VIEW_BYTES) {
      setContent({ path, loading: false, note: t("proj.files.tooLarge", { size: formatFileSize(size) }) });
      return;
    }
    const ctrl = new AbortController();
    let objectUrl: string | null = null;
    setContent({ path, loading: true });
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
  }, [enabled, fallback, hint, path, size, t, url]);

  return content;
}

export function FileView({ content, className = "" }: { content: FileContent; className?: string }) {
  const t = useT();
  const { path, kind, objectUrl, text, note, loading } = content;
  if (loading) return <div className={`grid min-h-40 place-items-center ${className}`}><div className="forge-spin" /></div>;
  if (note) return <p className={`grid min-h-full place-items-center p-6 text-center font-mono text-xs text-bone-faint ${className}`}>{note}</p>;
  if (kind === "pdf") return <iframe src={objectUrl} title={path} className={`h-full min-h-[32rem] w-full border-0 bg-white ${className}`} />;
  if (kind === "image") return <div className={`grid min-h-full place-items-center p-5 ${className}`}><img src={objectUrl} alt={fileName(path)} className="max-h-full max-w-full rounded" /></div>;
  if (kind === "markdown") return <article className={`mx-auto max-w-4xl p-6 text-sm leading-relaxed text-bone ${className}`}><Markdown source={text ?? ""} /></article>;
  if (kind === "text") return <HighlightedCode source={text ?? ""} language={languageForPath(path)} className={`min-h-full rounded-none border-0 ${className}`} />;
  return <p className={`grid min-h-full place-items-center p-6 text-center font-mono text-xs text-bone-faint ${className}`}>{t("session.preview.unsupported")}</p>;
}
