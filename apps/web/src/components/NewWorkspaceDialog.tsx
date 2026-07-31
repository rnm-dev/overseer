import { useState } from "react";
import { ApiError } from "../api";
import { useT } from "../i18n";
import { useWorkspace } from "../workspace";
import { Button, Dialog, Input, Label } from "../ui";

// author: Viktor

export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const t = useT();
  const { create } = useWorkspace();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await create(trimmed); // sets it current + refreshes
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t("newWs.failed"));
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("newWs.title")} onClose={onClose}>
      <div className="space-y-5">
        <div className="space-y-1.5">
          <Label>{t("newWs.name")}</Label>
          <Input
            autoFocus
            placeholder={t("newWs.placeholder")}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <p className="font-mono text-xs text-ink-faint">{t("newWs.hint")}</p>
        </div>

        {error && <div className="border border-danger/30 bg-danger/10 p-3 font-mono text-sm text-danger">{error}</div>}

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {t("action.cancel")}
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {busy ? t("newWs.creating") : t("newWs.create")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
