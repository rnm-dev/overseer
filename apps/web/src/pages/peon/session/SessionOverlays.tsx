import type { Dispatch, SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../../i18n";
import { ProjectFilePreviewModal, ProjectFileTree } from "../ProjectFiles";
import { AttachmentPreview } from "./AttachmentPreview";
import { PreviewPanel, type PreviewTarget } from "./PreviewPanel";
import type { MessageAttachment } from "./parsing";

interface FilePreview {
  path: string;
  size?: number;
  viewerUrl?: string;
}
interface Props {
  base: string;
  sid: string;
  projectKey: string | null;
  // Whether anything has told us yet which project this session belongs to.
  // Absent and not-yet-known are different states and must not read alike.
  projectKeyKnown: boolean;
  filesOpen: boolean;
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
  base, sid, projectKey, projectKeyKnown, filesOpen, projectFilePreview, setProjectFilePreview,
  attachmentPreview, setAttachmentPreview, sentAttachmentPreview,
  setSentAttachmentPreview, artifactPreview, setArtifactPreview,
  previewPinned, setPreviewPinned,
}: Props) {
  const t = useT();
  return (
    <>
      {filesOpen && createPortal(
        <aside className="session-files-pane fixed bottom-3 right-3 z-30 hidden w-80 min-h-0 flex-col overflow-hidden rounded-xl bg-surface-raised shadow-2xl lg:flex" style={{ top: "calc(var(--fixed-pane-header-height, 49px) + 0.75rem)" }} aria-label={t("session.files.title")}>
          {projectKey ? (
            <ProjectFileTree
              filesBase={`${base}/projects/${encodeURIComponent(projectKey)}/files`}
              activePath={projectFilePreview?.path}
              onOpenFile={(path, size) => setProjectFilePreview({ path, size })}
              onFileMoved={(source, destination) => setProjectFilePreview((current) => current?.path === source ? { ...current, path: destination } : current)}
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
          onClose={() => setProjectFilePreview(null)}
        />
      )}
    </>
  );
}
