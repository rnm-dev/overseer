import { useEffect, useState, type FormEvent } from "react";
import { Check, Copy, KeyRound, Plus, Trash2 } from "lucide-react";
import { ApiError } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Card, ConfirmationDialog, Input } from "../../shared/ui";
import {
  canRevoke,
  createAutomationToken,
  EXPIRY_CHOICES,
  isExpired,
  listAutomationTokens,
  orderedTokens,
  revokeAutomationToken,
  type AutomationToken,
  type ExpiryChoice,
} from "./automationTokens";

function when(at: number | null, locale: string): string {
  return at === null ? "" : new Date(at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export function ProjectAutomationTokens({ base, projectKey }: { base: string; projectKey: string }) {
  const t = useT();
  const [tokens, setTokens] = useState<AutomationToken[]>([]);
  const [canManageAll, setCanManageAll] = useState(false);
  const [label, setLabel] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>(90);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The secret half exists only here, only until the operator dismisses it.
  const [issued, setIssued] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<AutomationToken | null>(null);

  const message = (cause: unknown) => cause instanceof ApiError ? cause.message : t("error.generic");

  useEffect(() => {
    let alive = true;
    listAutomationTokens(base, projectKey)
      .then((list) => {
        if (!alive) return;
        setTokens(orderedTokens(list.tokens));
        setCanManageAll(list.canManageAll);
      })
      .catch((cause) => alive && setError(message(cause)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, projectKey]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createAutomationToken(base, projectKey, {
        label: label.trim() || null,
        expiresInDays: expiry,
      });
      setTokens((current) => orderedTokens([result.created, ...current]));
      setIssued(result.token);
      setCopied(false);
      setLabel("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setCreating(false);
    }
  }

  async function revoke(token: AutomationToken) {
    setBusy(token.id);
    setError(null);
    try {
      await revokeAutomationToken(base, projectKey, token.id);
      setTokens((current) => current.filter((item) => item.id !== token.id));
      setConfirmRevoke(null);
    } catch (cause) {
      setError(message(cause));
      setConfirmRevoke(null);
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued);
      setCopied(true);
    } catch {
      // A blocked clipboard is not a failure worth an alert — the token is on
      // screen and can still be selected by hand.
    }
  }

  const locale = typeof navigator === "undefined" ? "en" : navigator.language;

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-edge bg-surface-raised/40 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xs font-bold text-ink">{t("proj.tokens")}</h2>
          <p className="mt-0.5 truncate text-[0.68rem] text-ink-faint">{t("proj.tokens.hint")}</p>
        </div>
        <KeyRound size={13} className="flex-none text-ink-faint" aria-hidden />
      </div>

      <div className="space-y-2.5 p-3">
        {issued && (
          <div className="rounded-lg border border-accent/40 bg-accent/[0.07] p-3">
            <p className="mb-2 font-mono text-[0.68rem] text-accent-strong">⚡ {t("proj.tokens.created")}</p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded border border-edge bg-surface/60 px-2 py-1.5 font-mono text-[0.68rem] text-ink">{issued}</code>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-edge px-2.5 font-display text-[0.68rem] text-ink-muted transition-colors hover:border-accent/35 hover:text-ink"
                onClick={() => void copy()}
              >
                {copied ? <Check size={12} aria-hidden /> : <Copy size={12} aria-hidden />}
                {copied ? t("proj.tokens.copied") : t("proj.tokens.copy")}
              </button>
              <button
                type="button"
                className="h-8 rounded-md px-2.5 font-display text-[0.68rem] text-ink-faint transition-colors hover:text-ink"
                onClick={() => { setIssued(null); setCopied(false); }}
              >
                {t("proj.tokens.dismiss")}
              </button>
            </div>
          </div>
        )}

        {tokens.length === 0 && <p className="px-1 py-1 text-xs text-ink-faint">{t("proj.tokens.empty")}</p>}
        {tokens.length > 0 && (
          <div className="divide-y divide-edge overflow-hidden rounded-lg border border-edge">
            {tokens.map((token) => {
              const expired = isExpired(token);
              return (
                <div key={token.id} className="flex items-center gap-3 bg-surface/20 p-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-ink">
                      {token.label || t("proj.tokens.unnamed")}
                      {expired && <span className="ml-2 font-mono text-[0.62rem] text-danger">{t("proj.tokens.expired")}</span>}
                    </p>
                    <p className="mt-0.5 truncate font-mono text-[0.62rem] text-ink-faint">
                      {token.ownerEmail ?? token.ownerUserId}
                      {" · "}
                      {token.lastUsedAt === null
                        ? t("proj.tokens.neverUsed")
                        : t("proj.tokens.lastUsed", { when: when(token.lastUsedAt, locale) })}
                      {" · "}
                      {token.expiresAt === null
                        ? t("proj.tokens.noExpiry")
                        : t("proj.tokens.expiresAt", { when: when(token.expiresAt, locale) })}
                    </p>
                  </div>
                  {canRevoke(token, canManageAll) && (
                    <button
                      type="button"
                      className="grid h-8 w-8 flex-none place-items-center rounded-md text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-30"
                      aria-label={t("proj.tokens.revoke")}
                      disabled={busy !== null}
                      onClick={() => setConfirmRevoke(token)}
                    >
                      <Trash2 size={13} aria-hidden />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <form className="grid gap-1.5 rounded-lg border border-dashed border-edge-strong bg-surface/15 p-2 md:grid-cols-[minmax(10rem,2fr)_minmax(7rem,1fr)_auto] md:items-center" onSubmit={create}>
          <label className="sr-only" htmlFor="new-automation-token-label">{t("proj.tokens.label")}</label>
          <Input
            id="new-automation-token-label"
            className="h-8 px-2.5 text-xs"
            maxLength={120}
            value={label}
            disabled={creating}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t("proj.tokens.labelPlaceholder")}
          />
          <label className="sr-only" htmlFor="new-automation-token-expiry">{t("proj.tokens.expiry")}</label>
          <select
            id="new-automation-token-expiry"
            className="field h-8 px-2 text-xs"
            value={expiry === null ? "never" : String(expiry)}
            disabled={creating}
            onChange={(event) => setExpiry(event.target.value === "never" ? null : Number(event.target.value) as ExpiryChoice)}
          >
            {EXPIRY_CHOICES.map((choice) => (
              <option key={choice === null ? "never" : choice} value={choice === null ? "never" : String(choice)}>
                {choice === null ? t("proj.tokens.expiry.never") : t("proj.tokens.expiry.days", { days: String(choice) })}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-accent/35 bg-accent/10 px-3 font-display text-[0.68rem] font-semibold text-accent-strong transition-colors hover:bg-accent/15 disabled:opacity-40"
            disabled={creating}
          >
            <Plus size={12} aria-hidden /> {creating ? t("proj.tokens.creating") : t("proj.tokens.create")}
          </button>
        </form>

        {error && <p role="alert" className="px-1 font-mono text-xs text-danger">⚠ {error}</p>}
      </div>

      {confirmRevoke && <ConfirmationDialog
        title={t("proj.tokens.revokeConfirm", { name: confirmRevoke.label || t("proj.tokens.unnamed") })}
        confirmLabel={t("proj.tokens.revoke")}
        pendingLabel={t("proj.tokens.creating")}
        pending={busy === confirmRevoke.id}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={() => void revoke(confirmRevoke)}
      />}
    </Card>
  );
}
