import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { readStoredValue, writeStoredValue } from "../../shared/storedValue";
import { createPortal } from "react-dom";
import { useT } from "../../shared/i18n";
import { ProjectFilePreviewModal, ProjectFileTree } from "../projects/ProjectFiles";
import { AttachmentPreview } from "./AttachmentPreview";
import { PreviewPanel, type PreviewTarget } from "./PreviewPanel";
import type { MessageAttachment } from "./parsing";
import type { SessionPaneTab } from "./SessionHeader";
import { ProjectDocumentation } from "../projects/ProjectDocumentation";
import { useApiResource } from "../../shared/useApiResource";
import type { ProjectDetail } from "../fleet/peonApi";

const PANE_WIDTH_KEY = "overseer:session-pane:width";
const PANE_MIN_WIDTH = 260;
const PANE_MAX_WIDTH = 760;
// Leave the transcript at least this much room beside the pane.
const PANE_MIN_MAIN_WIDTH = 420;

function savedPaneWidth(): number | null {
  const value = Number(readStoredValue(PANE_WIDTH_KEY));
  return Number.isFinite(value) && value >= PANE_MIN_WIDTH && value <= PANE_MAX_WIDTH ? value : null;
}

// Drags the pane's left edge. The width is published as
// --session-files-pane-width, which the transcript, composer and scroll
// control already use to stay clear of the pane.
function SessionPaneResizeHandle() {
  const [width, setWidth] = useState(savedPaneWidth);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (width === null) return;
    const root = document.documentElement;
    root.style.setProperty("--session-files-pane-width", `${width}px`);
    return () => { root.style.removeProperty("--session-files-pane-width"); };
  }, [width]);

  useEffect(() => {
    if (!resizing) return;
    const sidebar = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peon-sidebar-width")) || 0;
    const resize = (event: PointerEvent) => {
      const maximum = Math.min(PANE_MAX_WIDTH, window.innerWidth - sidebar - PANE_MIN_MAIN_WIDTH);
      setWidth(Math.round(Math.max(PANE_MIN_WIDTH, Math.min(maximum, window.innerWidth - event.clientX))));
    };
    const stop = () => setResizing(false);
    document.documentElement.classList.add("peon-sidebar-resizing");
    window.addEventListener("pointermove", resize);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      document.documentElement.classList.remove("peon-sidebar-resizing");
      window.removeEventListener("pointermove", resize);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [resizing]);

  useEffect(() => {
    if (!resizing && width !== null) writeStoredValue(PANE_WIDTH_KEY, String(width));
  }, [resizing, width]);

  const nudge = useCallback((change: number) => {
    setWidth((current) => {
      const base = current ?? (document.querySelector(".session-files-pane")?.getBoundingClientRect().width ?? 344);
      return Math.round(Math.max(PANE_MIN_WIDTH, Math.min(PANE_MAX_WIDTH, base + change)));
    });
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize pane"
      aria-valuemin={PANE_MIN_WIDTH}
      aria-valuemax={PANE_MAX_WIDTH}
      aria-valuenow={width ?? undefined}
      tabIndex={0}
      className="absolute left-0 top-0 z-10 h-full w-2 cursor-col-resize touch-none outline-none panel-resize-handle"
      onPointerDown={(event) => {
        event.preventDefault();
        setResizing(true);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        nudge(event.key === "ArrowLeft" ? 16 : -16);
      }}
    />
  );
}

// The docs tab shows the same browser as the project overview, sized for the pane.
function SessionDocsPane({ base, projectKey }: { base: string; projectKey: string }) {
  const t = useT();
  const { data, error } = useApiResource<ProjectDetail>(`${base}/projects/${encodeURIComponent(projectKey)}`);
  if (error) return <p className="p-3 font-mono text-xs text-danger">⚠ {t("error.loadFailed")}</p>;
  if (!data) return <div className="grid flex-1 place-items-center"><span className="loading-spinner scale-75" role="status" aria-label={t("proj.docs.loading")} /></div>;
  return <div className="min-h-0 flex-1 overflow-y-auto"><ProjectDocumentation base={base} projectId={data.projectId ?? null} compact /></div>;
}

interface FilePreview {
  path: string;
  size?: number;
  viewerUrl?: string;
}
interface Props {
  peonId: string;
  base: string;
  sid: string;
  projectKey: string | null;
  // Whether anything has told us yet which project this session belongs to.
  // Absent and not-yet-known are different states and must not read alike.
  projectKeyKnown: boolean;
  filesOpen: boolean;
  paneTab: SessionPaneTab;
  fileRefreshRevision: number;
  projectFilePreview: FilePreview | null;
  setProjectFilePreview: Dispatch<SetStateAction<FilePreview | null>>;
  attachmentPreview: string | null;
  setAttachmentPreview: Dispatch<SetStateAction<string | null>>;
  sentAttachmentPreview: MessageAttachment | null;
  setSentAttachmentPreview: Dispatch<SetStateAction<MessageAttachment | null>>;
  artifactPreview: PreviewTarget | null;
  setArtifactPreview: Dispatch<SetStateAction<PreviewTarget | null>>;
  previewPinned: boolean;
  setPreviewPinned: Dispatch<SetStateAction<boolean>>;
}

export function SessionOverlays({
  peonId, base, sid, projectKey, projectKeyKnown, filesOpen, paneTab, fileRefreshRevision, projectFilePreview, setProjectFilePreview,
  attachmentPreview, setAttachmentPreview, sentAttachmentPreview,
  setSentAttachmentPreview, artifactPreview, setArtifactPreview,
  previewPinned, setPreviewPinned,
}: Props) {
  const t = useT();
  const [localFileRefreshRevision, setLocalFileRefreshRevision] = useState(0);
  return (
    <>
      {filesOpen && createPortal(
        <aside
          className="session-files-pane fixed bottom-1 right-1 z-30 hidden min-h-0 flex-col overflow-hidden glass-panel lg:flex"
          style={{ top: "var(--fixed-pane-header-height, 49px)", width: "calc(var(--session-files-pane-width) - 0.5rem)" }}
          aria-label={paneTab === "docs" ? t("session.tab.docs") : t("session.files.title")}
        >
          <SessionPaneResizeHandle />
          {projectKey && paneTab === "docs" ? (
            <SessionDocsPane base={base} projectKey={projectKey} />
          ) : projectKey ? (
            <ProjectFileTree
              peonId={peonId}
              projectKey={projectKey}
              filesBase={`${base}/projects/${encodeURIComponent(projectKey)}/files`}
              sourceFor={(path) => ({ kind: "project", base, projectKey, path })}
              activePath={projectFilePreview?.path}
              onOpenFile={(path, size) => setProjectFilePreview({ path, size })}
              onFileMoved={(source, destination) => setProjectFilePreview((current) => current?.path === source ? { ...current, path: destination } : current)}
              onFileDeleted={(path) => setProjectFilePreview((current) => current?.path === path ? null : current)}
              refreshRevision={fileRefreshRevision + localFileRefreshRevision}
              allowUpload
              className="flex-1"
            />
          ) : (
            <p className="p-3 font-mono text-xs leading-relaxed text-ink-faint">
              {t(projectKeyKnown ? "session.files.noProject" : "session.files.loading")}
            </p>
          )}
        </aside>,
        document.body,
      )}
      {attachmentPreview && createPortal(
        <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/85 p-8" onClick={() => setAttachmentPreview(null)}>
          <img src={attachmentPreview} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg" />
        </div>,
        document.body,
      )}
      {sentAttachmentPreview && <AttachmentPreview base={base} attachment={sentAttachmentPreview} onClose={() => setSentAttachmentPreview(null)} />}
      {artifactPreview && (
        <PreviewPanel
          base={base}
          sessionId={sid}
          target={artifactPreview}
          pinned={previewPinned}
          onPinnedChange={setPreviewPinned}
          onClose={() => {
            setArtifactPreview(null);
            setPreviewPinned(false);
          }}
          t={t}
        />
      )}
      {projectKey && projectFilePreview && (
        <ProjectFilePreviewModal
          source={{ kind: "project", base, projectKey, path: projectFilePreview.path }}
          path={projectFilePreview.path}
          size={projectFilePreview.size}
          viewerUrl={projectFilePreview.viewerUrl}
          onSaved={() => setLocalFileRefreshRevision((value) => value + 1)}
          onClose={() => setProjectFilePreview(null)}
        />
      )}
    </>
  );
}
