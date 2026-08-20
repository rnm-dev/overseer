import { useT } from "../../shared/i18n";
import { Button, Dialog } from "../../shared/ui";

// Leaving a file with a draft in hand has three answers, not two: the operator
// who edited a file and then clicked another one — or closed the window it was
// in — usually meant to keep the work, and being offered only "discard or
// stay" makes losing it the easy path. A refused save keeps the dialog open
// with its error rather than moving on, which is why `onSave` reports nothing
// here: the caller decides what a successful save leads to.
export function UnsavedChangesDialog({ name, error, saving, onCancel, onDiscard, onSave }: {
  name: string;
  error: string | null;
  saving: boolean;
  onCancel: () => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <Dialog title={t("file.discardTitle")} onClose={onCancel} dismissible={!saving}>
      <div className="mb-5 text-sm leading-relaxed text-ink-muted">{t("file.discardBody", { name })}</div>
      {error && <p className="mb-4 font-mono text-xs text-danger">{error}</p>}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="secondary" onClick={onCancel} disabled={saving}>{t("action.cancel")}</Button>
        <Button
          variant="secondary"
          className="!border-danger/50 !text-danger hover:!bg-danger/10"
          disabled={saving}
          onClick={onDiscard}
        >
          {t("file.discardConfirm")}
        </Button>
        <Button autoFocus disabled={saving} onClick={onSave}>
          {saving ? t("file.saving") : t("file.save")}
        </Button>
      </div>
    </Dialog>
  );
}
