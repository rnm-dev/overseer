import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, apiUpload } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { encodeFilePath } from "./fileLinks";
import type { FileKind } from "./fileLinks";

// Editing a file in place. Anything the app reads as text can be edited — the
// kinds it cannot are the ones it cannot render either: an image, a PDF, an
// archive. The gate is here rather than in the view so a surface cannot forget
// that a read-only tree may not save.

const EDITABLE_KINDS: ReadonlySet<FileKind> = new Set<FileKind>(["markdown", "text"]);

export const canEditFile = (kind: FileKind | undefined, writable: boolean): boolean =>
  writable && !!kind && EDITABLE_KINDS.has(kind);

// The one shortcut every editor has. `event.key` rather than a code, so a
// non-Latin layout still saves; Alt is excluded because Alt+Cmd+S belongs to
// the browser, not to us.
export const isSaveShortcut = (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">): boolean =>
  (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s";

// What the draft is measured against. The reader still reports the pre-save
// text for as long as the re-read takes, so a just-saved file has to be
// compared with what was written, or Save re-arms itself for a moment and the
// editor claims unsaved work that is already on disk.
export function editBaseline(
  saved: { path: string; text: string } | null,
  current: string | undefined,
  path: string,
): string | undefined {
  return saved && saved.path === path ? saved.text : current;
}

// A draft that matches the file on disk is not a change: reopening the editor
// and typing nothing must not arm the save button or the discard warning.
export const hasUnsavedChanges = (original: string | undefined, draft: string | null): boolean =>
  draft !== null && draft !== (original ?? "");

export function useFileEditor({ filesBase, path, original, originalPath, editable, onSaved }: {
  filesBase: string;
  path: string;
  // Which file `original` was read from. A pane that has been pointed at a new
  // file still holds the old one's text for a render or two, and seeding a
  // draft from that would let a save write one file's contents into another.
  originalPath: string;
  // Whether the file now in the pane may be edited at all. A sticky editor
  // must not try to open one over an image.
  editable: boolean;
  original: string | undefined;
  onSaved: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const [intent, setIntent] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<{ path: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A different file is a different document; an open editor never carries a
  // draft across to it.
  useEffect(() => {
    setDraft(null);
    setError(null);
  }, [path]);

  const current = originalPath === path ? original : undefined;
  const baseline = editBaseline(saved, current, path);

  // The written text stops standing in as soon as the reader agrees with it,
  // or the moment the pane moves to another file.
  useEffect(() => {
    if (saved && (saved.path !== path || current === saved.text)) setSaved(null);
  }, [current, path, saved]);

  const open = useCallback(() => {
    setIntent(true);
    setDraft(current ?? "");
  }, [current]);
  const close = useCallback(() => {
    setIntent(false);
    setDraft(null);
    setError(null);
  }, []);

  // Editing is a mode the operator is in, not a thing they do to one file:
  // once they are editing, the next file they open is editing too. The draft
  // waits for that file's bytes rather than being seeded with the last one's.
  useEffect(() => {
    if (!intent || draft !== null || !editable || current === undefined) return;
    setDraft(current);
  }, [current, draft, editable, intent]);

  // Leaving this file's changes behind without leaving the editor: the next
  // file the operator opens is still opened for editing.
  const discard = useCallback(() => {
    setDraft(null);
    setError(null);
  }, []);

  // Reports whether the file is now on disk, so a caller that was waiting to
  // move on — the operator switching files with a draft open — can.
  const save = useCallback(async (): Promise<boolean> => {
    if (draft === null || saving) return false;
    setSaving(true);
    setError(null);
    try {
      await apiUpload(`${filesBase}/${encodeFilePath(path)}`, new Blob([draft], { type: "text/plain" }), {
        headers: { "content-type": "application/octet-stream" },
      });
      // The draft stays open and stays as it is: it is now what the file
      // says, and Ctrl+S must not throw the operator out of the editor.
      setSaved({ path, text: draft });
      onSaved();
      return true;
    } catch (saveError) {
      setError(saveError instanceof ApiError && (saveError.status === 404 || saveError.status === 405)
        ? t("proj.files.uploadUnsupported")
        : saveError instanceof Error && saveError.message ? saveError.message : t("file.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, filesBase, onSaved, path, saving, t]);

  // The shortcut lives with the editor rather than with a view, so every
  // surface that opens one gets it. The ref keeps the listener from being
  // rebound on every keystroke, which is what `save` changing would cost.
  const latestSave = useRef(save);
  useEffect(() => { latestSave.current = save; }, [save]);
  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSaveShortcut(event)) return;
      // Otherwise the browser offers to save the page instead.
      event.preventDefault();
      void latestSave.current();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing]);

  return {
    draft,
    setDraft,
    editing,
    intent,
    dirty: hasUnsavedChanges(baseline, draft),
    saving,
    error,
    open,
    close,
    discard,
    save,
  };
}
