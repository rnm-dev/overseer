import { ArrowUpRight, LoaderCircle, LogIn } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, json } from "../../shared/api";
import { Button } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import { loginCodeAccepted, loginPath, loginPending, normalizeAttempt, pollDelay, type LoginAttempt } from "./providerLogin";
import type { Provider } from "./statsModel";

// Named distinctly from providerLogin.ts so case-insensitive filesystems resolve both modules reliably.

export function ProviderLogin({ base, provider, onSuccess }: {
  base: string; provider: Provider; onSuccess?: () => void;
}) {
  const t = useT();
  const [attempt, setAttempt] = useState<LoginAttempt | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const success = useRef(onSuccess);
  success.current = onSuccess;
  const path = loginPath(base, provider);
  const generation = useRef(0);
  const reported = useRef<string | null>(null);
  const requestVersion = useRef(0);
  function accept(next: LoginAttempt | null) {
    setAttempt(next);
    if (next?.status === "succeeded" && reported.current !== next.id) {
      reported.current = next.id;
      success.current?.();
    }
  }
  useEffect(() => {
    const scope = ++generation.current;
    let timer: ReturnType<typeof setTimeout>;
    setAttempt(null); setCode(""); setError(false); setBusy(true);
    const poll = async () => {
      const version = requestVersion.current;
      try {
        const next = normalizeAttempt(await api(path));
        if (generation.current !== scope || requestVersion.current !== version) return;
        accept(next); setError(false); setBusy(false);
        if (loginPending(next)) timer = setTimeout(poll, pollDelay(next));
      } catch {
        if (generation.current !== scope || requestVersion.current !== version) return;
        setError(true); setBusy(false);
      }
    };
    void poll();
    return () => { generation.current = scope + 1; clearTimeout(timer); };
  // revision recovers the authoritative attempt after every mutation or retry.
  }, [path, revision]);
  async function mutate(suffix: string, options: RequestInit) {
    const scope = generation.current;
    requestVersion.current++;
    setBusy(true); setError(false); setCode("");
    try {
      await api(`${path}${suffix}`, options);
      if (scope === generation.current) setRevision((v) => v + 1);
    } catch {
      if (scope === generation.current) { setBusy(false); setError(true); }
    }
  }
  const pending = loginPending(attempt);
  const url = attempt?.authorizationUrl ?? attempt?.verificationUrl;
  return <div className="mt-3 font-body text-sm">
    <div className="flex flex-wrap items-center gap-2">
      {!pending && <Button size="sm" disabled={busy} className="!rounded-lg gap-2" onClick={() => void mutate("", json({}))}>
        {busy ? <LoaderCircle size={14} className="animate-spin" aria-hidden="true" /> : <LogIn size={14} aria-hidden="true" />}{t("providerLogin.login")}
      </Button>}
      {pending && <>
        {(busy || !url) && <LoaderCircle size={14} className="animate-spin text-accent-strong" aria-hidden="true" />}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void mutate(`/${encodeURIComponent(attempt!.id)}`, { method: "DELETE" })}>{t("providerLogin.cancel")}</Button>
      </>}
    </div>
    <div className="space-y-3 empty:hidden [&:not(:empty)]:mt-3">
    {attempt && <p role="status" className="text-xs leading-relaxed text-ink-muted">{t(`providerLogin.${attempt.status}`)}</p>}
    {error && <p role="alert" className="text-danger">{t("providerLogin.error")}</p>}
    {url && <a className="inline-flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs font-medium text-accent-strong transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent" href={url} target="_blank" rel="noopener noreferrer">{t("providerLogin.open")}<ArrowUpRight size={14} aria-hidden="true" /></a>}
    {attempt?.userCode && <p>{t("providerLogin.code")}: <strong>{attempt.userCode}</strong></p>}
    {attempt?.status === "awaiting_code" && <form className="flex flex-wrap gap-2" onSubmit={(event) => {
      event.preventDefault();
      if (!busy && loginCodeAccepted(code)) void mutate(`/${encodeURIComponent(attempt.id)}/code`, json({ code: code.trim() }));
    }}>
      <input aria-label={t("providerLogin.code")} placeholder={t("providerLogin.code")} type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} className="min-w-0 flex-1 rounded-lg border border-edge bg-surface/80 px-3 py-2 font-mono text-xs outline-none transition-colors focus:border-accent focus:ring-1 focus:ring-accent" />
      <Button disabled={busy || !loginCodeAccepted(code)} type="submit" size="sm">{t("providerLogin.submit")}</Button>
    </form>}
    {error && <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRevision((v) => v + 1)}>{t("providerLogin.retry")}</Button>}
    </div>
  </div>;
}
