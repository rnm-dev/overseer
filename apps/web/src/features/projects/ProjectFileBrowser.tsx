import { useState } from "react";
import { Pencil } from "lucide-react";
import { useParams } from "react-router";
import { useT } from "../../shared/i18n";
import { Card } from "../../shared/ui";
import { useSplitPane } from "../../shared/splitPane";
import { useViewportFill } from "../../shared/viewportFill";
import { usePeon } from "../fleet/context";
import { CodeEditor } from "./CodeEditor";
import { canEditFile, useFileEditor } from "./fileEditing";
import { FileDownloadButton, FileView, useFileContent } from "./FileView";
import { ProjectFileTree } from "./ProjectFiles";
import { ProjectTabs } from "./ProjectTabs";
import { ProjectPageHeader } from "./ProjectPageHeader";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

const SPLIT_BOUNDS = { min: 200, max: 560, minTrailing: 320 };

// The controls are segments of the header bar rather than buttons floating in
// it: full height, square, divided from each other by the same rule.
const HEADER_SEGMENT = "flex h-full flex-none items-center gap-1.5 border-l border-edge px-3 font-display text-[0.68rem] font-semibold text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink disabled:cursor-default disabled:text-ink-faint/60 disabled:hover:bg-transparent";

export function ProjectFileBrowser() {
  const t = useT();
  const { key = "" } = useParams();
  const { peon, base } = usePeon();
  const filesBase = `${base}/projects/${encodeURIComponent(key)}/files`;
  const [selected, setSelected] = useState<{ path: string; size?: number } | null>(null);
  // The browser is a two-pane workspace, not an article: it ends where the
  // viewport ends rather than at a guessed offset below the header and tabs.
  const pane = useViewportFill({ minHeight: 448 });
  const split = useSplitPane({ storageKey: "overseer.project-files-split", defaultWidth: 304, bounds: SPLIT_BOUNDS });
  const [revision, setRevision] = useState(0);
  const [pendingOpen, setPendingOpen] = useState<{ path: string; size?: number } | null>(null);
  // A project tree is full of extensionless text (Dockerfile, LICENSE), so an
  // unknown type reads as text here rather than as an unsupported binary.
  const content = useFileContent({
    source: { kind: "project", base, projectKey: key, path: selected?.path ?? "" },
    size: selected?.size,
    fallback: "text",
    enabled: !!selected,
    revision,
  });
  const editable = canEditFile(content.kind, true);
  const editor = useFileEditor({
    filesBase,
    path: selected?.path ?? "",
    original: content.text,
    originalPath: content.path,
    editable,
    // The file on disk is no longer what was read, so the viewer reads again
    // instead of rendering the draft it happens to still hold.
    onSaved: () => setRevision((current) => current + 1),
  });
  // Opening another file with a draft in hand asks first; the answer decides
  // which file the pane ends up on. Editing is sticky, so leaving a file only
  // drops its draft rather than ending the mode.
  const openFile = (path: string, size?: number) => {
    if (editor.dirty) return setPendingOpen({ path, size });
    editor.discard();
    setSelected({ path, size });
  };

  if (!peon.online) return <p className="font-mono text-sm text-ink-faint">{t("peon.offlineNote")}</p>;

  return (
    <div className="space-y-3">
      <ProjectPageHeader />
      <ProjectTabs />
      <div ref={pane.ref} style={{ height: pane.height }}>
        <Card className="flex h-full min-h-[32rem] flex-col overflow-hidden lg:min-h-0">
          {/* One surface: the tree and the viewer share a border, and on a
              desktop viewport that border is what the operator drags. */}
          <div ref={split.container} className="relative flex min-h-0 flex-1 flex-col lg:flex-row">
            <div
              className="flex min-h-0 min-w-0 flex-1 flex-col border-b border-edge lg:flex-none lg:border-b-0 lg:border-r"
              style={split.width === undefined ? undefined : { width: split.width }}
            >
              <ProjectFileTree
                filesBase={filesBase}
                sourceFor={(path) => ({ kind: "project", base, projectKey: key, path })}
                activePath={selected?.path}
                onOpenFile={openFile}
                onFileMoved={(source, destination) => setSelected((current) => current?.path === source ? { ...current, path: destination } : current)}
                onFileDeleted={(path) => setSelected((current) => current?.path === path ? null : current)}
                allowUpload
                className="flex-1"
              />
            </div>
            {split.width !== undefined && (
              <div
                {...split.separatorProps}
                aria-label={t("proj.files.resize")}
                className={`absolute inset-y-0 z-10 -ml-1 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-px after:transition-colors hover:after:bg-accent/70 focus-visible:after:bg-accent ${split.resizing ? "after:bg-accent" : "after:bg-transparent"}`}
                style={{ left: split.width }}
              />
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col">
              {/* Nothing selected is an empty pane, not a sentence: the tree
                  beside it already says what to do. */}
              {!selected ? <div className="flex-1" /> : <>
                {/* A shade rather than a rule: the header still reads as its
                    own strip once the border under it is gone. */}
                <div className="flex h-8 flex-none items-stretch bg-surface-hover/40 font-mono text-xs text-ink-muted">
                  <span className="min-w-0 flex-1 self-center truncate px-3" title={selected.path}>{selected.path}</span>
                  {editor.error && <span className="flex-none self-center truncate px-2 text-danger" title={editor.error}>{editor.error}</span>}
                  {editor.editing ? <>
                    <button type="button" className={HEADER_SEGMENT} onClick={editor.close} disabled={editor.saving}>{t(editor.dirty ? "action.cancel" : "file.closeEditor")}</button>
                    <button type="button" className={`${HEADER_SEGMENT} text-accent-strong hover:bg-accent/15 hover:text-accent-strong`} title={t("file.saveShortcut")} onClick={() => void editor.save()} disabled={!editor.dirty || editor.saving}>
                      {editor.saving ? t("file.saving") : t("file.save")}
                    </button>
                  </> : editable && (
                    <button type="button" className={HEADER_SEGMENT} onClick={editor.open}>
                      <Pencil size={13} aria-hidden />
                      {t("file.edit")}
                    </button>
                  )}
                  <FileDownloadButton source={{ kind: "project", base, projectKey: key, path: selected.path }} variant="segment" />
                </div>
                {editor.editing ? (
                  <div className="min-h-0 flex-1 overflow-auto">
                    <CodeEditor value={editor.draft ?? ""} onChange={editor.setDraft} label={selected.path} />
                  </div>
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto"><FileView content={content} /></div>
                )}
              </>}
            </div>
          </div>
        </Card>
      </div>
      {pendingOpen && (
        <UnsavedChangesDialog
          name={selected?.path ?? ""}
          error={editor.error}
          saving={editor.saving}
          onCancel={() => setPendingOpen(null)}
          onDiscard={() => {
            editor.discard();
            setSelected(pendingOpen);
            setPendingOpen(null);
          }}
          onSave={() => void editor.save().then((saved) => {
            // A refused save keeps the dialog open with its error, rather than
            // moving on and leaving the operator to guess.
            if (!saved) return;
            setSelected(pendingOpen);
            setPendingOpen(null);
          })}
        />
      )}
    </div>
  );
}
