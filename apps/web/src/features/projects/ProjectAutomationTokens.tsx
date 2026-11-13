import { useEffect, useState } from "react";
import { Check, ClipboardCheck, Copy, KeyRound, Plus, Send, Sparkles, Trash2 } from "lucide-react";
import { ApiError } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Card, ConfirmationDialog } from "../../shared/ui";
import { AutomationApiGuide } from "./AutomationApiGuide";
import {
  canRevoke,
  createAutomationToken,
  isExpired,
  listAutomationTokens,
  orderedTokens,
  revokeAutomationToken,
  type AutomationToken,
} from "./automationTokens";

function when(at: number | null, locale: string): string {
  return at === null ? "" : new Date(at).toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });
}

export function ProjectAutomationTokens({ base, projectKey }: { base: string; projectKey: string }) {
  const t = useT();
  const [tokens, setTokens] = useState<AutomationToken[]>([]);
  const [canManageAll, setCanManageAll] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
      .catch((cause) => alive && setError(message(cause)))
      .finally(() => alive && setLoaded(true));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, projectKey]);

  // One button, no options: a key for this project that lasts a year.
  async function create() {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createAutomationToken(base, projectKey, {
        label: null,
        expiresInDays: 365,
      });
      setTokens((current) => orderedTokens([result.created, ...current]));
      setIssued(result.token);
      setCopied(false);
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
  const hasKeys = tokens.length > 0 || issued !== null;

  // Before any key exists the card is only a short, friendly explanation and
  // one button; the URL, the example and the key list appear with the first key.
  if (!loaded) return null;
  if (!hasKeys) {
    const steps = [
      { icon: KeyRound, key: "proj.api.step1" },
      { icon: Send, key: "proj.api.step2" },
      { icon: ClipboardCheck, key: "proj.api.step3" },
    ] as const;
    return (
      <Card className="overflow-hidden">
        <div className="relative px-5 py-5">
          <div aria-hidden className="pointer-events-none absolute -right-10 -top-12 h-40 w-40 rounded-full bg-accent/10 blur-3xl" />
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-accent/15 text-accent-strong">
              <Sparkles size={17} aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-sm font-bold text-ink">{t("proj.api.introTitle")}</h2>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">{t("proj.api.introBody", { project: projectKey })}</p>
            </div>
          </div>
          <ol className="mt-4 grid gap-2 sm:grid-cols-3">
            {steps.map(({ icon: Icon, key }, index) => (
              <li key={key} className="flex items-start gap-2 rounded-lg border border-edge bg-surface/30 p-2.5">
                <span className="grid h-5 w-5 flex-none place-items-center rounded-full bg-accent/15 font-display text-[0.62rem] font-bold text-accent-strong">{index + 1}</span>
                <span className="min-w-0 text-[0.7rem] leading-snug text-ink">
                  <Icon size={12} aria-hidden className="mr-1 inline-block align-[-2px] text-ink-muted" />
                  {t(key)}
                </span>
              </li>
            ))}
          </ol>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn-accent inline-flex h-9 items-center gap-1.5 rounded-lg px-4 font-display text-xs font-semibold disabled:opacity-40"
              disabled={creating}
              onClick={() => void create()}
            >
              <Plus size={14} aria-hidden /> {creating ? t("proj.tokens.creating") : t("proj.api.createKey")}
            </button>
            <span className="text-[0.68rem] text-ink-faint">{t("proj.api.introNote")}</span>
          </div>
          {error && <p role="alert" className="mt-3 font-mono text-xs text-danger">⚠ {error}</p>}
        </div>
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex items-center gap-3 border-b border-edge bg-surface-raised/40 px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xs font-bold text-ink">{t("proj.api")}</h2>
          <p className="mt-0.5 text-[0.68rem] text-ink-faint">{t("proj.api.hint", { project: projectKey })}</p>
        </div>
        <KeyRound size={13} className="flex-none text-ink-faint" aria-hidden />
      </div>

      <div className="space-y-3 p-3">
        {!issued && (
          <button
            type="button"
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-md border border-accent/35 bg-accent/10 px-3 font-display text-[0.68rem] font-semibold text-accent-strong transition-colors hover:bg-accent/15 disabled:opacity-40"
            disabled={creating}
            onClick={() => void create()}
          >
            <Plus size={12} aria-hidden /> {creating ? t("proj.tokens.creating") : t(tokens.length === 0 ? "proj.api.createKey" : "proj.api.createAnother")}
          </button>
        )}
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

        <AutomationApiGuide token={issued} />

        {tokens.length > 0 && <h3 className="pt-1 font-display text-[0.68rem] font-semibold text-ink-muted">{t("proj.api.keys")}</h3>}
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
