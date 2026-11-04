import { useState } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { api } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Button, ConfirmationDialog, Dialog } from "../../shared/ui";

// Resets a member's password to a server-chosen temporary one and shows it
// exactly once. Used by owners on the workspace members screen and by project
// administrators on a project's members tab; the server refuses owners and
// oneself, so the caller only decides where the button appears.
export function MemberPasswordReset({ endpoint, name, onError }: { endpoint: string; name: string; onError: (message: string) => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function reset() {
    setPending(true);
    try {
      const result = await api<{ temporaryPassword: string }>(endpoint, { method: "POST" });
      setPassword(result.temporaryPassword);
    } catch (err) {
      onError(err instanceof Error ? err.message : t("members.passwordResetFailed"));
    } finally {
      setPending(false);
      setConfirming(false);
    }
  }

  async function copy() {
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      setCopied(true);
    } catch {
      onError(t("invites.copyFailed"));
    }
  }

  return <>
    <button type="button" title={t("members.passwordReset")} aria-label={t("members.passwordResetFor", { name })} className="grid h-9 w-9 place-items-center rounded-md text-ink-faint transition-colors hover-wash hover:text-ink disabled:opacity-40" disabled={pending} onClick={() => setConfirming(true)}><KeyRound size={15} aria-hidden /></button>
    {confirming && <ConfirmationDialog
      title={t("members.passwordResetFor", { name })}
      description={t("members.passwordResetHint")}
      confirmLabel={t("members.passwordReset")}
      pending={pending}
      onClose={() => setConfirming(false)}
      onConfirm={() => void reset()}
    />}
    {password && <Dialog title={t("members.passwordResetDone", { name })} onClose={() => { setPassword(null); setCopied(false); }}>
      <p className="mb-4 text-sm leading-relaxed text-ink-muted">{t("members.passwordResetOnce")}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 select-all break-all rounded-md border border-edge bg-surface px-3 py-2 font-mono text-sm text-ink">{password}</code>
        <Button variant="secondary" onClick={() => void copy()}>{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? t("invites.copied") : t("invites.copy")}</Button>
      </div>
    </Dialog>}
  </>;
}
