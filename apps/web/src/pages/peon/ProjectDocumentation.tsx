import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, ChevronRight, Folder, RefreshCw, TriangleAlert } from "lucide-react";
import { api, ApiError } from "../../api";
import { Markdown } from "../../components/RichText";
import { useT } from "../../i18n";
import { Card } from "../../ui";
import { FileTypeIcon } from "./FileTypeIcon";
import { fileApiPath } from "./fileLinks";

export interface DocumentationEntry {
  name: string;
  type: "directory" | "file";
}

export interface DocumentationListing {
  exists: boolean;
  entries: DocumentationEntry[];
}

export type DocumentationPresentation =
  | { kind: "missing" }
  | { kind: "index"; entry: DocumentationEntry }
  | { kind: "listing"; entries: DocumentationEntry[] };

type DocumentationState =
  | { kind: "loading"; path?: string }
  | { kind: "missing" }
  | { kind: "document"; path: string; source: string }
  | { kind: "listing"; entries: DocumentationEntry[] }
  | { kind: "error"; code: string; path?: string };

const MAX_INDEX_BYTES = 512 * 1024;
const TRANSIENT_CODES = new Set(["SYNC_IN_PROGRESS", "PEON_OFFLINE", "CONNECTION_LOST", "PEON_TRANSFER_UNAVAILABLE", "PEON_TRANSFER_REPLACED"]);

export function documentationPresentation(listing: DocumentationListing): DocumentationPresentation {
  if (!listing.exists) return { kind: "missing" };
  const index = listing.entries.find((entry) => entry.type === "file" && entry.name === "index.md");
  return index ? { kind: "index", entry: index } : { kind: "listing", entries: listing.entries };
}

export function documentationListingPath(base: string, projectId: string): string {
  return `${base}/projects/${encodeURIComponent(projectId)}/docs`;
}

export function documentationFilePath(base: string, projectId: string, path: string): string {
  return fileApiPath({ kind: "projectById", base, projectId, path });
}

export function resolveDocumentationLink(currentPath: string, href: string): string | null {
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")
    || /^[a-z][a-z\d+.-]*:/i.test(raw)) return null;
  let decoded: string;
  try { decoded = decodeURIComponent(raw.split(/[?#]/, 1)[0]); } catch { return null; }
  if (!decoded || decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = currentPath.split("/").slice(0, -1);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const path = parts.join("/");
  return /\.(?:md|markdown|mdx)$/i.test(path) ? path : null;
}

export function documentationBreadcrumbs(path?: string): string[] {
  return !path || path === "docs/index.md" ? ["docs"] : path.split("/").filter(Boolean);
}

async function responseError(response: Response): Promise<ApiError> {
  let body: { code?: string; error?: string } | null = null;
  try { body = await response.json(); } catch { /* non-JSON response */ }
  return new ApiError(response.status, body?.code ?? "ERROR", body?.error || response.statusText || "Documentation could not be loaded");
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener("abort", aborted);
      resolve();
    };
    const aborted = () => {
      globalThis.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = globalThis.setTimeout(done, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
}

export async function retryDocumentationRequest<T>(work: () => Promise<T>, signal: AbortSignal, delays = [120, 320, 700]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await work(); } catch (error) {
      if (!(error instanceof ApiError) || !TRANSIENT_CODES.has(error.code) || attempt >= delays.length) throw error;
      await wait(delays[attempt], signal);
    }
  }
}

async function fetchDocument(base: string, projectId: string, path: string, signal: AbortSignal): Promise<string> {
  return retryDocumentationRequest(async () => {
    const response = await fetch(`/api${documentationFilePath(base, projectId, path)}`, {
      signal,
      credentials: "same-origin",
    });
    if (!response.ok) throw await responseError(response);
    const length = Number(response.headers.get("content-length"));
    if (Number.isFinite(length) && length > MAX_INDEX_BYTES) throw new ApiError(413, "DOCS_TOO_LARGE", "Documentation index is too large to preview");
    const source = await response.text();
    if (new TextEncoder().encode(source).byteLength > MAX_INDEX_BYTES) throw new ApiError(413, "DOCS_TOO_LARGE", "Documentation index is too large to preview");
    return source;
  }, signal);
}

function errorCopy(code: string, t: ReturnType<typeof useT>): string {
  if (code === "UNSUPPORTED_CAPABILITY") return t("proj.docs.unsupported");
  if (["PEON_OFFLINE", "CONNECTION_LOST", "PEON_TRANSFER_UNAVAILABLE"].includes(code)) return t("proj.docs.offline");
  if (code === "DOCS_TOO_LARGE") return t("proj.docs.tooLarge");
  return t("proj.docs.failed");
}

export function ProjectDocumentation({ base, projectId }: { base: string; projectId: string | null }) {
  const t = useT();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<DocumentationState>({ kind: "loading" });
  const requestRef = useRef<AbortController | null>(null);

  const goHome = useCallback(() => {
    requestRef.current?.abort();
    setRevision((value) => value + 1);
  }, []);

  const openDocument = useCallback((path: string) => {
    if (!projectId) return;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setState({ kind: "loading", path });
    fetchDocument(base, projectId, path, controller.signal)
      .then((source) => {
        if (requestRef.current === controller) setState({ kind: "document", path, source });
      })
      .catch((error) => {
        if (!controller.signal.aborted && requestRef.current === controller) {
          setState({ kind: "error", path, code: error instanceof ApiError ? error.code : "ERROR" });
        }
      });
  }, [base, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    requestRef.current?.abort();
    requestRef.current = controller;
    if (!projectId) {
      setState({ kind: "error", code: "UNKNOWN_PROJECT_ID" });
      return () => controller.abort();
    }
    setState({ kind: "loading" });
    retryDocumentationRequest(
      () => api<DocumentationListing>(documentationListingPath(base, projectId), { signal: controller.signal, cache: "no-store" }),
      controller.signal,
    )
      .then(async (listing) => {
        if (requestRef.current !== controller) return;
        const presentation = documentationPresentation(listing);
        if (presentation.kind === "missing") return setState({ kind: "missing" });
        if (presentation.kind === "listing") return setState({ kind: "listing", entries: presentation.entries });
        const path = "docs/index.md";
        const source = await fetchDocument(base, projectId, path, controller.signal);
        if (requestRef.current === controller) setState({ kind: "document", path, source });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState({ kind: "error", code: error instanceof ApiError ? error.code : "ERROR" });
      });
    return () => {
      controller.abort();
      if (requestRef.current === controller) requestRef.current = null;
    };
  }, [base, projectId, revision]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const activePath = state.kind === "document" || state.kind === "loading" || state.kind === "error" ? state.path : undefined;
  const breadcrumbs = documentationBreadcrumbs(activePath);
  const refresh = () => activePath && activePath !== "docs/index.md" ? openDocument(activePath) : goHome();

  return (
    <Card className="overflow-hidden">
      <header className="relative flex min-h-12 items-center gap-3 border-b border-edge/90 bg-gradient-to-r from-accent/[0.07] via-transparent to-transparent px-5 py-2 sm:px-6">
        <nav aria-label={t("proj.docs.breadcrumbs")} className="flex min-w-0 flex-1 items-center gap-1 font-display text-sm font-bold tracking-wide">
          <button type="button" onClick={goHome} className="shrink-0 text-ink-muted transition-colors hover:text-accent-strong">{t("proj.docs.project")}</button>
          {breadcrumbs.map((part, index) => {
            const last = index === breadcrumbs.length - 1;
            const home = index === 0 && part === "docs";
            return <span key={`${part}-${index}`} className="contents">
              <ChevronRight size={13} className="shrink-0 text-ink-faint/55" aria-hidden />
              {home && !last
                ? <button type="button" onClick={goHome} className="min-w-0 truncate text-ink-muted transition-colors hover:text-accent-strong">{part}</button>
                : <span className={`min-w-0 truncate ${last ? "text-ink" : "text-ink-muted"}`} title={part}>{part}</span>}
            </span>;
          })}
        </nav>
        <button
          type="button"
          onClick={refresh}
          disabled={state.kind === "loading"}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-transparent text-ink-faint transition-colors hover:border-edge-strong hover:bg-surface-hover hover:text-ink disabled:opacity-40"
          aria-label={t("proj.docs.refresh")}
          title={t("proj.docs.refresh")}
        >
          <RefreshCw size={15} className={state.kind === "loading" ? "animate-spin" : ""} aria-hidden />
        </button>
      </header>

      {state.kind === "loading" ? <DocumentationSkeleton label={t("proj.docs.loading")} />
        : state.kind === "missing" ? <DocumentationEmpty title={t("proj.docs.empty")} detail={t("proj.docs.emptyHint")} />
          : state.kind === "error" ? (
            <div className="flex flex-col items-center px-6 py-10 text-center">
              <div className="grid h-11 w-11 place-items-center rounded-full border border-warning-strong/25 bg-warning-strong/10 text-warning-strong"><TriangleAlert size={20} aria-hidden /></div>
              <p className="mt-3 max-w-lg text-sm text-ink-muted">{errorCopy(state.code, t)}</p>
              <button type="button" className="mt-4 font-mono text-xs text-accent-strong hover:underline" onClick={refresh}>{t("proj.docs.retry")}</button>
            </div>
          ) : state.kind === "document" ? (
            <article className="mx-auto max-w-4xl px-5 py-6 text-sm leading-relaxed text-ink sm:px-8 sm:py-8">
              <Markdown source={state.source} onOpenLink={(href) => {
                const path = resolveDocumentationLink(state.path, href);
                if (!path) return false;
                openDocument(path);
                return true;
              }} />
            </article>
          ) : <DocumentationFileList entries={state.entries} emptyLabel={t("proj.docs.folderEmpty")} />}
    </Card>
  );
}

function DocumentationEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-11 text-center">
      <div className="relative grid h-14 w-14 place-items-center rounded-2xl border border-dashed border-edge-emphasis bg-surface-raised/65 text-ink-faint">
        <BookOpen size={25} aria-hidden />
        <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-edge-subtle bg-surface-disabled" />
      </div>
      <h3 className="mt-4 font-display text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-ink-faint">{detail}</p>
    </div>
  );
}

function DocumentationFileList({ entries, emptyLabel }: { entries: DocumentationEntry[]; emptyLabel: string }) {
  if (!entries.length) return <p className="px-6 py-9 text-center font-mono text-xs text-ink-faint">{emptyLabel}</p>;
  return (
    <ul className="divide-y divide-iron-800/80" aria-label="docs">
      {entries.map((entry) => (
        <li key={`${entry.type}:${entry.name}`} className="group flex min-h-11 items-center gap-3 px-5 py-2.5 transition-colors hover:bg-accent/[0.035] sm:px-6">
          {entry.type === "directory" ? <Folder size={16} className="shrink-0 fill-accent/10 text-accent-deep" aria-hidden /> : <FileTypeIcon name={entry.name} size={16} />}
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-muted group-hover:text-ink" title={entry.name}>{entry.name}</span>
          <span className="font-mono text-[0.6rem] uppercase tracking-[0.12em] text-ink-faint/60">{entry.type === "directory" ? "dir" : "file"}</span>
        </li>
      ))}
    </ul>
  );
}

function DocumentationSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-3 px-6 py-7">
      <div className="h-5 w-2/5 animate-pulse rounded bg-surface-active/65" />
      <div className="h-3 w-full animate-pulse rounded bg-surface-hover" />
      <div className="h-3 w-11/12 animate-pulse rounded bg-surface-hover" />
      <div className="h-3 w-4/5 animate-pulse rounded bg-surface-hover" />
      <span className="sr-only">{label}</span>
    </div>
  );
}
