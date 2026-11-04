import { useState, type FormEvent } from "react";
import { Check, Copy, KeyRound } from "lucide-react";
import { api, json } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Button, Dialog, Input } from "../../shared/ui";

// Sets a member's password: the administrator types one, or leaves the field
// empty and the server generates one, shown here exactly once. Used by owners on the workspace members screen and by project
// administrators on a project's members tab; the server refuses owners and
// oneself, so the caller only decides where the button appears.
export function MemberPasswordReset({ endpoint, name, onError }: { endpoint: string; name: string; onError: (message: string) => void }) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [password, setPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [chosen, setChosen] = useState("");
  const [repeat, setRepeat] = useState("");
  const [done, setDone] = useState(false);
  const mismatch = chosen !== "" && repeat !== "" && chosen !== repeat;

  function close() {
    setConfirming(false);
    setChosen("");
    setRepeat("");
  }

  async function reset(event: FormEvent) {
    event.preventDefault();
    if (chosen !== repeat) return;
    setPending(true);
    try {
      const result = await api<{ temporaryPassword: string | null }>(endpoint, chosen ? json({ password: chosen }) : { method: "POST" });
      if (result.temporaryPassword) setPassword(result.temporaryPassword);
      else setDone(true);
      close();
    } catch (err) {
      onError(err instanceof Error ? err.message : t("members.passwordResetFailed"));
      close();
    } finally {
      setPending(false);
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
    <button type="button" title={t("members.passwordChange")} aria-label={t("members.passwordResetFor", { name })} className="grid h-9 w-9 place-items-center rounded-md text-ink-faint transition-colors hover-wash hover:text-ink disabled:opacity-40" disabled={pending} onClick={() => setConfirming(true)}><KeyRound size={15} aria-hidden /></button>
    {confirming && <Dialog title={t("members.passwordResetFor", { name })} onClose={close} dismissible={!pending}>
      <form className="space-y-3" onSubmit={(event) => void reset(event)}>
        <p className="text-sm leading-relaxed text-ink-muted">{t("members.passwordResetHint")}</p>
        <Input type="password" autoComplete="new-password" value={chosen} onChange={(event) => setChosen(event.target.value)} placeholder={t("members.passwordNewPlaceholder")} autoFocus />
        {chosen && <Input type="password" autoComplete="new-password" value={repeat} onChange={(event) => setRepeat(event.target.value)} placeholder={t("members.passwordRepeat")} />}
        {mismatch && <p className="font-mono text-xs text-danger">{t("members.passwordMismatch")}</p>}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={close} disabled={pending}>{t("action.cancel")}</Button>
          <Button type="submit" disabled={pending || (chosen !== "" && chosen !== repeat)}>{chosen ? t("members.passwordSet") : t("members.passwordGenerate")}</Button>
        </div>
      </form>
    </Dialog>}
    {done && <Dialog title={t("members.passwordSetDone", { name })} onClose={() => setDone(false)}>
      <p className="text-sm leading-relaxed text-ink-muted">{t("members.passwordSetDoneHint")}</p>
    </Dialog>}
    {password && <Dialog title={t("members.passwordResetDone", { name })} onClose={() => { setPassword(null); setCopied(false); }}>
      <p className="mb-4 text-sm leading-relaxed text-ink-muted">{t("members.passwordResetOnce")}</p>
      <div className="flex items-center gap-2">
        <code className="flex-1 select-all break-all rounded-md border border-edge bg-surface px-3 py-2 font-mono text-sm text-ink">{password}</code>
        <Button variant="secondary" onClick={() => void copy()}>{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied ? t("invites.copied") : t("invites.copy")}</Button>
      </div>
    </Dialog>}
  </>;
}
