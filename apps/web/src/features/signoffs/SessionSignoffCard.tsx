import { useCallback, useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { api } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Dialog } from "../../shared/ui";
import { SignoffView } from "./SignoffDetail";
import type { SignoffSummary } from "./signoffApi";

// A session's sign-offs waiting for a decision, shown as cards at the end of
// its transcript — where the agent stopped — so a person reading the chat sees
// why it is waiting. Deciding happens on the sign-off card.

const WAITING = new Set(["pending", "changes_requested"]);

export type SessionSignoff = SignoffSummary & { summary?: string | null };

export function useSessionSignoffs(wsId: string | undefined, peonId: string, sessionId: string, running: boolean): SessionSignoff[] {
  const [open, setOpen] = useState<SessionSignoff[]>([]);
  const load = useCallback(async () => {
    if (!wsId) return;
    try {
      const body = await api<{ signoffs: SessionSignoff[] }>(
        `/workspaces/${encodeURIComponent(wsId)}/peons/${encodeURIComponent(peonId)}/sessions/${encodeURIComponent(sessionId)}/signoffs`,
      );
      setOpen(body.signoffs.filter((row) => WAITING.has(row.status)));
    } catch {
      setOpen([]);
    }
  }, [peonId, sessionId, wsId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    const onChange = () => void load();
    window.addEventListener("overseer:signoffs-changed", onChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("overseer:signoffs-changed", onChange);
    };
    // A turn starting or ending is when sign-offs appear or change.
  }, [load, running]);
  return open;
}

export function SessionSignoffCard({ signoff, wsId }: { signoff: SessionSignoff; wsId: string }) {
  const t = useT();
  const revising = signoff.status === "changes_requested";
  // Deciding opens the sign-off over the chat, so the conversation stays in view.
  const [open, setOpen] = useState(false);
  const decide = signoff.canDecide && !revising;
  return (
    <>
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="surface group text-left relative mr-auto flex w-full max-w-md items-center gap-3 overflow-hidden py-2.5 pl-3.5 pr-2.5 transition-colors hover:border-accent/50 md:max-w-2xl"
      aria-labelledby={`session-signoff-${signoff.id}`}
      data-session-signoff={signoff.status}
    >
      <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-accent" />
      <span className="min-w-0 flex-1">
        <span id={`session-signoff-${signoff.id}`} className="block font-body text-sm font-medium text-ink">
          <span className="mr-1.5 text-ink-faint">{signoff.displayNumber}</span>{signoff.title}
        </span>
        {signoff.summary && <span className="mt-0.5 line-clamp-3 font-body text-xs leading-relaxed text-ink-muted">{signoff.summary}</span>}
      </span>
      <span className={`btn ${decide ? "btn-accent" : "btn-secondary"} btn-sm inline-flex shrink-0 items-center gap-1`}>
        {t(decide ? "signoffs.card.decide" : "signoffs.card.open")}
        <ArrowRight size={13} aria-hidden className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </button>
    {open && (
      <Dialog title={`${signoff.displayNumber} · ${signoff.title}`} size="lg" onClose={() => setOpen(false)}>
        <SignoffView wsId={wsId} signoffPeonId={signoff.peonId} signoffId={signoff.id} embedded />
      </Dialog>
    )}
    </>
  );
}
