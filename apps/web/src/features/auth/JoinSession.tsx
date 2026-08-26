import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router";
import { api, ApiError } from "../../shared/api";
import { Button, Input } from "../../shared/ui";
import { useAuth } from "./auth";

type AccessMode = "read" | "participate";
export type Preview = {
  workspaceId: string;
  peonId: string;
  sessionId: string;
  sessionTitle: string | null;
  sessionStatus: string | null;
  suggestedDisplayName: string;
  accessMode: AccessMode;
  limits: { maxTurns: number; maxDurationMs: number; maxTokens: number };
  expiresAt: number;
  alreadyAuthorized: boolean;
  authenticated: boolean;
  existingParticipant?: boolean;
};

interface Participant {
  participantId: string;
  identity: {
    kind: "authenticated" | "guest";
    email: string | null;
    githubLogin: string | null;
    displayName: string;
  };
  displayName: string;
  accessMode: AccessMode;
  status: "active" | "expired" | "revoked";
  usage: { turns: number; tokens: number; costMicros: number; quality: string };
}

export interface Acceptance {
  alreadyAuthorized: boolean;
  workspaceId: string;
  peonId: string;
  sessionId: string;
  sessionTitle: string | null;
  accessMode: AccessMode | null;
  participant: (Participant & { expiresAt: number | null }) | null;
  webSocketTicket: { ticket: string; expiresAt: number } | null;
}

export function canonicalSessionPath(value: { workspaceId: string; peonId: string; sessionId: string }): string {
  return `/workspaces/${encodeURIComponent(value.workspaceId)}/sessions/${encodeURIComponent(value.peonId)}/${encodeURIComponent(value.sessionId)}`;
}

export function invitationState(error: unknown): "revoked" | "expired" | "invalid" | null {
  if (!(error instanceof ApiError)) return "invalid";
  if (error.code === "INVITATION_REVOKED") return "revoked";
  if (error.code === "INVITATION_EXPIRED") return "expired";
  return "invalid";
}

export function sharedState(error: unknown): "revoked" | "expired" | "exhausted" | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "PARTICIPANT_REVOKED") return "revoked";
  if (error.code === "PARTICIPANT_EXPIRED") return "expired";
  if (error.code === "PARTICIPANT_LIMIT_EXHAUSTED") return "exhausted";
  return null;
}

export function JoinSession() {
  const { token = "" } = useParams();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [displayName, setDisplayName] = useState("");
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<unknown>(null);
  const [acceptance, setAcceptance] = useState<Acceptance | null>(null);

  useEffect(() => {
    let alive = true;
    setPreview(null);
    setLoadError(null);
    if (!token) return undefined;
    api<Preview>(`/session-invitations/${encodeURIComponent(token)}`)
      .then((value) => {
        if (!alive) return;
        setPreview(value);
        setDisplayName(value.suggestedDisplayName);
      })
      .catch((error: unknown) => alive && setLoadError(error));
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (preview?.alreadyAuthorized) navigate(canonicalSessionPath(preview), { replace: true });
  }, [navigate, preview]);

  async function accept(event?: FormEvent) {
    event?.preventDefault();
    if (!token || accepting) return;
    setAccepting(true);
    setAcceptError(null);
    try {
      const response = await api<{ acceptance: Acceptance }>(`/session-invitations/${encodeURIComponent(token)}`, {
        method: "POST",
        body: JSON.stringify(user ? {} : { displayName }),
      });
      if (response.acceptance.alreadyAuthorized) {
        navigate(canonicalSessionPath(response.acceptance), { replace: true });
      } else {
        setAcceptance(response.acceptance);
      }
    } catch (error) {
      setAcceptError(error);
    } finally {
      setAccepting(false);
    }
  }

  if (acceptance && preview) return <SharedSessionPage preview={preview} acceptance={acceptance} onRefreshAcceptance={() => accept()} />;

  const state = invitationState(loadError ?? acceptError);
  if (state) return <JoinSessionState state={state} />;
  if (!preview) {
    return <div className="grid min-h-screen place-items-center"><div className="loading-spinner" /></div>;
  }
  return (
    <main className="min-h-screen bg-canvas px-4 py-8 sm:px-6 sm:py-14">
      <div className="mx-auto w-full max-w-xl">
        <div className="mb-8 text-center">
          <p className="font-mono text-xs uppercase tracking-[0.28em] text-accent-strong">Overseer · shared session</p>
          <h1 className="mt-3 font-display text-3xl font-bold text-ink">Join the conversation</h1>
          <p className="mt-2 font-mono text-sm text-ink-muted">{preview.sessionTitle || "Untitled session"}</p>
        </div>
        <section className="surface space-y-5 p-5 sm:p-7" aria-labelledby="join-session-heading">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-edge-subtle pb-4">
            <div>
              <h2 id="join-session-heading" className="font-display text-lg font-semibold text-ink">You are joining as a {preview.accessMode === "read" ? "reader" : "participant"}</h2>
              <p className="mt-1 font-mono text-xs text-ink-faint">Access expires {new Date(preview.expiresAt).toLocaleString()}</p>
            </div>
            <span className="badge badge-subtle">{preview.accessMode === "read" ? "Read only" : "Participate"}</span>
          </div>
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-3 font-mono text-xs leading-5 text-warning-strong" role="note">
            Participant messages permanently affect the shared conversation. Only continue if you understand that your messages, attachments, tool actions, and confirmations are visible to the session owner.
          </div>
          {user ? (
            <div className="rounded-lg border border-edge-subtle bg-surface-raised/50 px-3 py-3 font-mono text-sm text-ink-muted">
              Continuing as <span className="font-semibold text-ink">{user.githubLogin || user.email}</span>. Your authenticated identity will be retained; the suggested guest name is not used.
            </div>
          ) : (
            <label className="block space-y-1.5 font-mono text-xs text-ink-muted">
              Display name
              <Input autoFocus maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} aria-describedby="join-name-help" required />
              <span id="join-name-help" className="block text-[0.68rem] text-ink-faint">This name is shown as Guest in the shared transcript.</span>
            </label>
          )}
          <div className="grid grid-cols-3 gap-2 rounded-lg border border-edge-subtle p-3 font-mono text-xs text-ink-muted">
            <span><strong className="block text-ink">{preview.limits.maxTurns}</strong> hard turns</span>
            <span><strong className="block text-ink">{Math.round(preview.limits.maxDurationMs / 3_600_000)}h</strong> duration</span>
            <span><strong className="block text-ink">{preview.limits.maxTokens.toLocaleString()}</strong> tokens reported</span>
          </div>
          {acceptError !== null && <p className="font-mono text-xs text-danger" role="alert">{acceptError instanceof Error ? acceptError.message : "Could not join this session."}</p>}
          <Button className="w-full" type="button" disabled={accepting || (!user && displayName.trim().length === 0)} onClick={() => void accept()}>
            {accepting ? "Joining…" : "Enter shared session"}
          </Button>
        </section>
      </div>
    </main>
  );
}

export function joinSessionStateCopy(state: "revoked" | "expired" | "invalid"): [string, string] {
  return state === "revoked"
    ? ["Invitation revoked", "The session manager revoked this invitation. Existing participants are unaffected, but this link can no longer admit anyone new."]
    : state === "expired"
      ? ["Invitation expired", "This invitation is no longer accepting new participants."]
      : ["Invitation unavailable", "This invitation is invalid or has already been removed."];
}

export function JoinSessionState({ state }: { state: "revoked" | "expired" | "invalid" }) {
  const copy = joinSessionStateCopy(state);
  return (
    <main className="grid min-h-screen place-items-center bg-canvas px-5 text-center">
      <section className="surface max-w-md space-y-3 p-7">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-ink-faint">Overseer · shared session</p>
        <h1 className="font-display text-2xl font-bold text-ink">{copy[0]}</h1>
        <p className="font-mono text-sm leading-6 text-ink-muted">{copy[1]}</p>
        <a className="btn btn-secondary inline-flex" href="/">Return home</a>
      </section>
    </main>
  );
}

function eventLabel(event: unknown): { author: string; text: string } {
  if (!event || typeof event !== "object") return { author: "Session", text: String(event ?? "") };
  const value = event as Record<string, unknown>;
  const authorValue = value.author ?? value.actor ?? value.email ?? value.role;
  const textValue = value.text ?? value.message ?? value.content ?? value.prompt ?? value.summary;
  const text = typeof textValue === "string" ? textValue : typeof value.data === "string" ? value.data : JSON.stringify(event);
  return { author: typeof authorValue === "string" ? authorValue : "Session", text };
}

function SharedSessionPage({ preview, acceptance, onRefreshAcceptance }: { preview: Preview; acceptance: Acceptance; onRefreshAcceptance: () => void }) {
  const [events, setEvents] = useState<unknown[]>([]);
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [state, setState] = useState<"revoked" | "expired" | "exhausted" | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const base = `/workspaces/${encodeURIComponent(acceptance.workspaceId)}/peons/${encodeURIComponent(acceptance.peonId)}`;
  const sessionPath = `${base}/sessions/${encodeURIComponent(acceptance.sessionId)}`;
  const canParticipate = acceptance.accessMode === "participate" && !state;
  const turnsUsed = acceptance.participant?.usage.turns ?? 0;
  const exhausted = turnsUsed >= preview.limits.maxTurns;

  const load = useCallback(async () => {
    try {
      const [session, transcript] = await Promise.all([
        acceptance.accessMode === "participate" ? api<Record<string, unknown>>(sessionPath) : Promise.resolve(null),
        api<{ events?: unknown[] }>(`${sessionPath}/transcript?limit=100`),
      ]);
      if (session) setMetadata(session);
      setEvents(Array.isArray(transcript.events) ? transcript.events : []);
      setError(null);
    } catch (nextError) {
      setError(nextError);
      const nextState = sharedState(nextError);
      if (nextState) setState(nextState);
    }
  }, [acceptance.accessMode, sessionPath]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const ticket = acceptance.webSocketTicket?.ticket;
    if (!ticket) return undefined;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws?ticket=${encodeURIComponent(ticket)}`);
    wsRef.current = socket;
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", workspaceId: acceptance.workspaceId }));
      socket.send(JSON.stringify({ type: "subscribe", peonId: acceptance.peonId, sessionId: acceptance.sessionId }));
      socket.send(JSON.stringify({ type: "presence:set", scope: "session", peonId: acceptance.peonId, sessionId: acceptance.sessionId, active: true }));
    });
    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string; error?: string };
        if (message.type === "tail") void load();
        if (message.type === "participantRevoked" || message.type === "tailError" && message.error?.includes("revok")) setState("revoked");
      } catch {
        /* The HTTP transcript remains the recovery path. */
      }
    });
    socket.addEventListener("close", (event) => {
      if (event.code === 4403) setState("revoked");
    });
    return () => {
      socket.close();
      wsRef.current = null;
    };
  }, [acceptance.peonId, acceptance.sessionId, acceptance.webSocketTicket?.ticket, acceptance.workspaceId, load]);

  useEffect(() => {
    const heartbeat = window.setInterval(() => {
      const socket = wsRef.current;
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
    }, 10_000);
    return () => window.clearInterval(heartbeat);
  }, []);

  async function upload(file: File): Promise<{ type: "file" | "image"; path: string; size?: number; sha256?: string }> {
    const safeName = file.name.replace(/[^\w.-]+/gu, "_") || "file";
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const result = await api<{ path?: string; size?: number; sha256?: string }>(`${base}/files/uploads/${encodeURIComponent(acceptance.sessionId)}/${encodeURIComponent(safeName)}`, {
      method: "PUT",
      body: bytes,
      headers: { "content-type": "application/octet-stream", "peon-content-sha256": sha256 },
    });
    if (!result.path) throw new Error("The attachment was not committed by Peon.");
    return { type: /^image\//u.test(file.type) ? "image" : "file", path: result.path, size: result.size, sha256: result.sha256 };
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canParticipate || exhausted || (!input.trim() && files.length === 0) || sending) return;
    setSending(true);
    setError(null);
    try {
      const attachments = [];
      for (const file of files) attachments.push(await upload(file));
      await api(sessionPath + "/followup", {
        method: "POST",
        headers: { "Peon-Request-Id": crypto.randomUUID() },
        body: JSON.stringify({ prompt: input.trim() || "(see attachments)", ...(attachments.length ? { attachments } : {}) }),
      });
      setInput("");
      setFiles([]);
      await load();
    } catch (nextError) {
      setError(nextError);
      const nextState = sharedState(nextError);
      if (nextState) setState(nextState);
    } finally {
      setSending(false);
    }
  }

  if (state) {
    const title = state === "revoked" ? "Access revoked" : state === "expired" ? "Access expired" : "Turn limit exhausted";
    const message = state === "revoked" ? "The session manager revoked your participant access. Your earlier messages remain attributed in the conversation." : state === "expired" ? "Your participant access has expired. The shared conversation remains canonical." : "This invitation's hard turn limit has been reached. Token usage remains reported until authoritative reconciliation is available.";
    return <main className="grid min-h-screen place-items-center bg-canvas px-5 text-center"><section className="surface max-w-lg space-y-3 p-7"><p className="font-mono text-xs uppercase tracking-[0.25em] text-ink-faint">Shared session</p><h1 className="font-display text-2xl font-bold text-ink">{title}</h1><p className="font-mono text-sm leading-6 text-ink-muted">{message}</p></section></main>;
  }

  return (
    <main className="min-h-screen bg-canvas px-3 py-4 sm:px-6 sm:py-8">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-5xl flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-3 px-1">
          <div><p className="font-mono text-xs uppercase tracking-[0.25em] text-accent-strong">Shared session</p><h1 className="mt-1 font-display text-2xl font-bold text-ink">{String(metadata?.title ?? acceptance.sessionTitle ?? "Untitled session")}</h1><p className="mt-1 font-mono text-xs text-ink-faint">Canonical conversation · {acceptance.accessMode === "read" ? "read only" : "participant"}</p></div>
          <span className="badge badge-subtle">{acceptance.participant ? acceptance.participant.identity.kind === "guest" ? `Guest · ${acceptance.participant.displayName}` : acceptance.participant.identity.githubLogin || acceptance.participant.identity.email || acceptance.participant.displayName : "Authenticated participant"}</span>
        </header>
        <section className="surface flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex-1 space-y-3 overflow-y-auto p-4 sm:p-6" aria-live="polite">
            {events.length === 0 ? <p className="py-12 text-center font-mono text-sm text-ink-faint">No transcript entries yet.</p> : events.map((event, index) => { const line = eventLabel(event); return <article key={`${index}-${line.text.slice(0, 20)}`} className="rounded-lg border border-edge-subtle bg-surface-raised/50 p-3"><p className="font-mono text-[0.68rem] font-semibold text-accent-strong">{line.author}</p><p className="mt-1 whitespace-pre-wrap font-body text-sm leading-6 text-ink">{line.text}</p></article>; })}
          </div>
          <div className="border-t border-edge-subtle p-3 sm:p-4">
            {!canParticipate ? <p className="rounded-lg bg-surface-raised/60 px-3 py-3 font-mono text-xs text-ink-muted">This invitation is read-only. You can follow the transcript but cannot change the conversation.</p> : <form onSubmit={(event) => void submit(event)} className="space-y-2"><textarea className="field min-h-24 w-full resize-y" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Write a message to the shared session…" aria-label="Message" /><div className="flex flex-wrap items-center justify-between gap-2"><label className="btn btn-secondary btn-sm cursor-pointer">Attach files<input className="sr-only" type="file" multiple onChange={(event: ChangeEvent<HTMLInputElement>) => setFiles(Array.from(event.target.files ?? []))} /></label><span className="font-mono text-[0.68rem] text-ink-faint">{files.length ? `${files.length} attachment(s) selected` : `${Math.max(0, preview.limits.maxTurns - turnsUsed)} hard turns remaining`}</span><Button type="submit" disabled={sending || exhausted || (!input.trim() && files.length === 0)}>{sending ? "Sending…" : "Send"}</Button></div></form>}
            {error !== null && <p className="mt-2 font-mono text-xs text-danger" role="alert">{error instanceof Error ? error.message : "The session could not be updated."}</p>}
            <p className="mt-2 font-mono text-[0.65rem] leading-5 text-ink-faint">Token usage is reported after authoritative reconciliation; turn and duration limits are enforced before actions.</p>
            <button type="button" className="mt-2 font-mono text-[0.68rem] text-accent-strong underline" onClick={onRefreshAcceptance}>Refresh access</button>
          </div>
        </section>
      </div>
    </main>
  );
}
