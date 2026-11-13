import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { api, ApiError } from "../../shared/api";
import { useT, type MessageKey } from "../../shared/i18n";
import { Button } from "../../shared/ui";
import { useOutletContext } from "react-router";
import type { PeonContext } from "../fleet/context";
import { notifySignoffsChanged, signoffPath, type SignoffView } from "./signoffApi";
import { signoffStatusTone } from "./SignoffSidebarList";

// Long agent text is folded to a few lines; one click shows the rest.
function Folded({ text, lines, className }: { text: string; lines: 3 | 6; className: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const long = text.length > (lines === 3 ? 240 : 420) || text.split("\n").length > lines;
  return (
    <div>
      <p className={`whitespace-pre-wrap ${className} ${long && !open ? (lines === 3 ? "line-clamp-3" : "line-clamp-6") : ""}`}>{text}</p>
      {long && (
        <button type="button" className="mt-1 font-body text-xs text-ink-muted hover:text-accent-strong"
          onClick={(event) => { event.stopPropagation(); setOpen(!open); }}>
          {t(open ? "signoffs.showLess" : "signoffs.showMore")}
        </button>
      )}
    </div>
  );
}

type Choice = { kind: "approved"; optionId: string } | { kind: "rejected" } | { kind: "commented" } | null;

// One sign-off: what the agent wants, its options and the decision. The
// decision is bound to the version on screen (baseSeq); Peon refuses it if the
// agent revised meanwhile, and the card reloads.
export function SignoffDetail() {
  const { wsId } = useOutletContext<PeonContext>();
  const { signoffPeonId, signoffId } = useParams();
  return <SignoffView wsId={wsId} signoffPeonId={signoffPeonId} signoffId={signoffId} />;
}

// The card itself, used by the page and by the dialog the chat opens. In the
// dialog the session link is dropped (you are in it) and the outer padding is
// the dialog's.
export function SignoffView({ wsId, signoffPeonId, signoffId, embedded = false }: {
  wsId: string | undefined;
  signoffPeonId: string | undefined;
  signoffId: string | undefined;
  embedded?: boolean;
}) {
  const t = useT();
  const [view, setView] = useState<SignoffView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Choice>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<"card" | "history">("card");

  const path = wsId && signoffPeonId && signoffId ? signoffPath(wsId, signoffPeonId, signoffId) : null;
  const load = useCallback(async () => {
    if (!path) return;
    try {
      setView(await api<SignoffView>(path));
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof ApiError && error.code === "PEON_OFFLINE" ? t("signoffs.peonOffline") : t("error.loadFailed"));
    }
  }, [path, t]);
  useEffect(() => {
    setView(null);
    setChoice(null);
    setMessage("");
    setNotice(null);
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const submit = async () => {
    if (!path || !view || !choice) return;
    setBusy(true);
    setNotice(null);
    try {
      await api(`${path}/events`, {
        method: "POST",
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          kind: choice.kind,
          baseSeq: view.signoff.headSeq,
          optionId: choice.kind === "approved" ? choice.optionId : undefined,
          message: message.trim() || undefined,
        }),
      });
      setChoice(null);
      setMessage("");
      notifySignoffsChanged();
    } catch (error) {
      const code = error instanceof ApiError ? error.code : "";
      setNotice(code === "SIGNOFF_CHANGED" ? t("signoffs.changed", { number: view.signoff.displayNumber })
        : code === "SIGNOFF_SESSION_GONE" ? t("signoffs.sessionGone")
        : error instanceof Error ? error.message : t("error.loadFailed"));
    } finally {
      setBusy(false);
      await load();
    }
  };

  if (loadError && !view) return <div className="p-6 font-body text-sm text-ink-muted">{loadError}</div>;
  if (!view) return <div className="flex min-h-40 items-center justify-center"><span className="loading-spinner" role="status" /></div>;

  const { signoff, snapshot, events } = view;
  const approval = [...events].reverse().find((event) => event.kind === "approved");
  const executed = [...events].reverse().find((event) => event.kind === "executed" || event.kind === "interrupted");
  const results = new Map((executed?.results ?? []).map((result) => [result.actionId, result]));
  const deciding = signoff.canDecide;
  const commentable = !signoff.orphaned && (signoff.status === "pending" || signoff.status === "changes_requested");
  const options = approval && !deciding ? snapshot.options.filter((option) => option.id === approval.optionId) : snapshot.options;
  const sessionTo = `/peons/${encodeURIComponent(signoff.peonId)}/sessions/${encodeURIComponent(signoff.sessionId)}`;
  const authorName = (event: SignoffView["events"][number]) =>
    event.author.type === "operator" ? event.author.id : event.author.type === "policy" ? t("signoffs.policy") : event.author.type === "peon" ? "Peon" : t("signoffs.agent");

  return (
    <div className={embedded ? "w-full" : "mx-auto w-full max-w-3xl overflow-y-auto px-4 py-6 md:px-8"}>
      <div className="font-body text-xs text-ink-muted">
        {signoff.displayNumber} · {signoff.peonName}{signoff.projectKey ? ` · ${signoff.projectKey}` : ""}{!embedded && <> · <Link className="hover:text-accent-strong" to={sessionTo}>{t("signoffs.openSession")}</Link></>}
      </div>
      {!embedded && <h1 className="mt-1 font-display text-xl text-ink">{snapshot.title}</h1>}
      <p className={`mt-1 font-body text-sm ${signoffStatusTone(signoff.status)}`}>
        {t(`signoffs.status.${signoff.status}` as MessageKey)}{deciding ? ` — ${t("signoffs.yourDecision")}` : ""}{signoff.orphaned ? ` — ${t("signoffs.sessionGone")}` : ""}
      </p>

      <div className="mt-4 flex gap-3 border-b border-edge font-body text-xs">
        {(["card", "history"] as const).map((value) => (
          <button key={value} type="button" onClick={() => setTab(value)}
            className={`-mb-px border-b-2 pb-1.5 ${tab === value ? "border-accent text-ink" : "border-transparent text-ink-muted hover:text-ink"}`}>
            {t(`signoffs.tab.${value}` as MessageKey)}
          </button>
        ))}
      </div>

      {tab === "history" ? (
        <ol className="mt-4 space-y-3">
          {events.map((event) => (
            <li key={event.seq} className="font-body text-sm">
              <div className="text-xs text-ink-muted">
                #{event.seq} · {t(`signoffs.event.${event.kind}` as MessageKey)} · {authorName(event)} · {new Date(event.createdAt).toLocaleString()}
              </div>
              {event.message && <p className="mt-0.5 whitespace-pre-wrap text-ink">{event.message}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <>
          <div className="mt-4"><Folded text={snapshot.summary} lines={3} className="font-body text-sm leading-relaxed text-ink-muted" /></div>
          {snapshot.context.length > 0 && (
            <div className="mt-3 space-y-1">
              {snapshot.context.map((excerpt, index) => (
                <blockquote key={index} className="rounded-lg bg-ink/[0.03] px-3 py-2 font-body text-xs italic text-ink-muted whitespace-pre-wrap">{excerpt}</blockquote>
              ))}
            </div>
          )}

          {deciding && <p className="mt-6 font-display text-[0.68rem] font-semibold uppercase tracking-[0.14em] text-ink-faint">{t("signoffs.choose")}</p>}
          <ul className={deciding ? "mt-2 space-y-1" : "mt-5 space-y-1"} role={deciding ? "radiogroup" : undefined}>
            {options.map((option) => {
              const selected = choice?.kind === "approved" && choice.optionId === option.id;
              return (
                <li key={option.id}
                  role={deciding ? "radio" : undefined}
                  aria-checked={deciding ? selected : undefined}
                  className={`rounded-xl px-3 py-3 transition-colors ${selected ? "bg-accent/[0.08] ring-1 ring-accent/50" : deciding ? "cursor-pointer hover-wash" : ""}`}
                  onClick={() => deciding && setChoice({ kind: "approved", optionId: option.id })}>
                  <div className="flex items-start gap-3">
                    {deciding && (
                      <span aria-hidden className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${selected ? "border-accent" : "border-edge-strong"}`}>
                        {selected && <span className="size-2 rounded-full bg-accent" />}
                      </span>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 font-body text-sm font-semibold text-ink">
                        {option.label}
                        {option.recommended && <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[0.65rem] font-medium text-accent-strong">{t("signoffs.recommended")}</span>}
                      </div>
                      {option.rationale && <p className="mt-0.5 font-body text-xs text-ink-muted">{option.rationale}</p>}
                      <ol className="mt-2 space-y-2">
                        {option.actions.map((action, index) => {
                          const result = results.get(action.id);
                          return (
                            <li key={action.id} className="font-body text-sm text-ink">
                              <span className="mr-1.5 text-ink-faint">{result ? (result.outcome === "done" ? "✓" : result.outcome === "failed" ? "!" : "·") : option.actions.length > 1 ? `${index + 1}.` : "→"}</span>
                              {action.summary}
                              {action.detail && (
                                <div className="mt-1.5 rounded-lg bg-ink/[0.04] px-3 py-2">
                                  <Folded text={action.detail} lines={6} className="font-body text-sm leading-relaxed text-ink-muted" />
                                </div>
                              )}
                              {result?.note && <div className="mt-0.5 text-xs text-ink-muted">{result.note}</div>}
                            </li>
                          );
                        })}
                      </ol>
                      {selected && (
                        <div className="mt-3 flex justify-end">
                          <Button size="sm" disabled={busy} onClick={(event) => { event.stopPropagation(); void submit(); }}>
                            {t("signoffs.goAhead")}
                          </Button>
                        </div>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {(deciding || commentable) && (
            <div className="mt-3 px-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-body text-sm">
                <span className="text-ink-faint">{t("signoffs.or")}</span>
                <button type="button" onClick={() => setChoice({ kind: "commented" })}
                  className={choice?.kind === "commented" ? "font-medium text-accent-strong" : "text-ink-muted hover:text-ink"}>
                  {t("signoffs.somethingElse")}
                </button>
                {deciding && (
                  <button type="button" onClick={() => setChoice({ kind: "rejected" })}
                    className={choice?.kind === "rejected" ? "font-medium text-danger" : "text-ink-muted hover:text-danger"}>
                    {t("signoffs.reject")}
                  </button>
                )}
              </div>
              {(choice?.kind === "rejected" || choice?.kind === "commented") && (
                <div className="mt-2 space-y-2">
                  <textarea value={message} onChange={(event) => setMessage(event.target.value)} rows={3} maxLength={8000} autoFocus
                    placeholder={t(choice.kind === "rejected" ? "signoffs.reasonPlaceholder" : "signoffs.commentPlaceholder")}
                    className="field w-full p-2 font-body text-sm" />
                  <div className="flex justify-end">
                    <Button size="sm" variant={choice.kind === "rejected" ? "secondary" : "accent"} disabled={busy || (choice.kind === "commented" && !message.trim())} onClick={() => void submit()}>
                      {t(choice.kind === "rejected" ? "signoffs.reject" : "signoffs.send")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {notice && <p className="mt-3 font-body text-sm text-danger" role="alert">{notice}</p>}
          {signoff.status === "done" || signoff.status === "partly_done" || signoff.status === "failed" ? (
            <p className="mt-4 font-body text-xs text-ink-faint">{t("signoffs.agentReported")}</p>
          ) : null}
        </>
      )}
    </div>
  );
}
