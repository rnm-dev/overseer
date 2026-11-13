import { KeyRound, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { api, json } from "../../shared/api";
import { Button } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import { loginPath } from "./providerLogin";
import { providerName, type Provider } from "./statsModel";

// Drivers whose capabilities say `loginKind: "api-key"` (OpenRouter behind
// opencode) sign in by submitting a key. Peon validates it with the provider
// and stores it; GET only ever returns a masked hint.
interface KeyStatus {
  loggedIn: boolean;
  keyHint: string | null;
}

function keyStatus(raw: unknown): KeyStatus | null {
  const value = raw !== null && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!value || typeof value.loggedIn !== "boolean") return null;
  return { loggedIn: value.loggedIn, keyHint: typeof value.keyHint === "string" ? value.keyHint : null };
}

export function ApiKeyLogin({ base, provider, onSuccess }: { base: string; provider: Provider; onSuccess?: () => void }) {
  const t = useT();
  const path = loginPath(base, provider);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api(path)
      .then((raw) => { if (alive) { setStatus(keyStatus(raw)); setError(null); } })
      .catch(() => { if (alive) setError(t("providerLogin.error")); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [path, t]);

  async function save() {
    const apiKey = key.trim();
    if (!apiKey || busy) return;
    setBusy(true); setError(null);
    try {
      setStatus(keyStatus(await api(path, json({ apiKey }))));
      setKey("");
      onSuccess?.();
    } catch (failure) {
      const code = (failure as { code?: unknown })?.code;
      setError(code === "INVALID_API_KEY" ? t("providerLogin.apiKeyInvalid") : t("providerLogin.error"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="my-4 overflow-hidden rounded-xl border border-accent/20 bg-gradient-to-br from-accent/10 via-surface-raised/40 to-surface p-4 font-body text-sm shadow-sm">
    <div className="flex min-w-0 items-center gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-accent/20 bg-accent/10 text-accent-strong" aria-hidden="true">
        {busy ? <LoaderCircle size={17} className="animate-spin" /> : <KeyRound size={17} />}
      </span>
      <span className="font-display text-xs font-semibold tracking-wide text-ink">{providerName(t, provider)}</span>
    </div>
    <div className="mt-3 space-y-3">
      {status && <p role="status" className="text-xs leading-relaxed text-ink-muted">
        {status.loggedIn ? t("providerLogin.apiKeyStored", { hint: status.keyHint ?? "" }) : t("providerLogin.apiKeyMissing")}
      </p>}
      <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <input aria-label={t("providerLogin.apiKey")} placeholder={t("providerLogin.apiKey")} type="password" autoComplete="off" spellCheck={false}
          value={key} onChange={(event) => setKey(event.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-edge bg-surface/80 px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent" />
        <Button disabled={busy || !key.trim()} type="submit" size="sm">{t("providerLogin.apiKeySave")}</Button>
      </form>
      {error && <p role="alert" className="text-danger">{error}</p>}
    </div>
  </div>;
}
