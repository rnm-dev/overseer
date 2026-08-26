import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError } from "../../shared/api";
import { Button, Dialog, Input } from "../../shared/ui";

type AccessMode = "read" | "participate";
type Status = "active" | "expired" | "revoked";

interface Limits {
  maxTurns: number;
  maxDurationMs: number;
  maxTokens: number;
  maxCostMicros: number;
}

interface Invitation {
  id: string;
  displayName: string;
  accessMode: AccessMode;
  limits: Limits;
  expiresAt: number;
  revokedAt: number | null;
  status: Status;
  participantCount: number;
  activeParticipantCount: number;
}

interface Participant {
  participantId: string;
  invitationId: string | null;
  identity: {
    kind: "authenticated" | "guest";
    email: string | null;
    githubLogin: string | null;
    displayName: string;
    userId: string | null;
  };
  displayName: string;
  accessMode: AccessMode;
  provenance: "direct" | "invitation";
  joinedAt: number;
  lastActiveAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  status: Status;
  usage: { turns: number; tokens: number; costMicros: number; quality: string };
  presence: { status: "online" | "away" | "offline"; lastSeenAt: number | null };
}

interface Props {
  base: string;
  sessionId: string;
  open: boolean;
  onClose: () => void;
}

const DAY = 24 * 60 * 60 * 1_000;

function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "FORBIDDEN") return "Only the session manager can manage invitations.";
    if (error.code === "PARTICIPANT_LIMIT_EXHAUSTED") return "This participant has exhausted the hard turn limit.";
    return error.message;
  }
  return "The sharing request failed.";
}

function dateLabel(value: number | null): string {
  return value ? new Date(value).toLocaleString() : "Never";
}

export function SessionSharingPanel({ base, sessionId, open, onClose }: Props) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [name, setName] = useState("Guest");
  const [accessMode, setAccessMode] = useState<AccessMode>("participate");
  const [maxTurns, setMaxTurns] = useState("10");
  const [durationHours, setDurationHours] = useState("24");
  const [expiryDays, setExpiryDays] = useState("7");
  const [maxTokens, setMaxTokens] = useState("100000");
  const [maxCostUsd, setMaxCostUsd] = useState("5");
  const [joinUrl, setJoinUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const invitationsPath = `${base}/sessions/${encodeURIComponent(sessionId)}/invitations`;
  const participantsPath = `${base}/sessions/${encodeURIComponent(sessionId)}/participants`;

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      const [invites, roster] = await Promise.all([
        api<{ invitations: Invitation[] }>(invitationsPath),
        api<{ participants: Participant[] }>(participantsPath),
      ]);
      setInvitations(invites.invitations ?? []);
      setParticipants(roster.participants ?? []);
      setError(null);
    } catch (nextError) {
      setError(errorText(nextError));
    }
  }, [invitationsPath, participantsPath, sessionId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [open, refresh]);

  const activeInvitations = useMemo(() => invitations.filter((invitation) => invitation.status === "active"), [invitations]);

  async function createInvitation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ invitation: Invitation; token: string }>(invitationsPath, {
        method: "POST",
        body: JSON.stringify({
          displayName: name,
          accessMode,
          maxTurns: Number(maxTurns),
          maxDurationMs: Number(durationHours) * 60 * 60 * 1_000,
          maxTokens: Number(maxTokens),
          maxCostUsd: Number(maxCostUsd),
          expiresInMs: Number(expiryDays) * DAY,
        }),
      });
      setJoinUrl(`${window.location.origin}/join/session/${encodeURIComponent(result.token)}`);
      await refresh();
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function revokeInvitation(id: string) {
    setBusy(true);
    try {
      await api(`${invitationsPath}/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function toggleInvitation(invitation: Invitation) {
    setBusy(true);
    try {
      await api(`${invitationsPath}/${encodeURIComponent(invitation.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ accessMode: invitation.accessMode === "read" ? "participate" : "read" }),
      });
      await refresh();
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  async function revokeParticipant(id: string) {
    setBusy(true);
    try {
      await api(`${participantsPath}/${encodeURIComponent(id)}`, { method: "DELETE" });
      await refresh();
    } catch (nextError) {
      setError(errorText(nextError));
    } finally {
      setBusy(false);
    }
  }

  function copyLink() {
    if (joinUrl) void navigator.clipboard?.writeText(joinUrl).catch(() => undefined);
  }

  if (!open) return null;
  return (
    <Dialog title="Share this session" onClose={onClose} size="lg">
      <div className="space-y-5">
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-xs leading-5 text-warning-strong">
          Participant messages permanently affect this shared conversation. Share only with people you trust.
        </p>
        <form className="space-y-3" onSubmit={(event) => void createInvitation(event)}>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 font-mono text-xs text-ink-muted">Suggested guest name<Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} required /></label>
            <label className="space-y-1 font-mono text-xs text-ink-muted">Access<select className="field w-full" value={accessMode} onChange={(event) => setAccessMode(event.target.value as AccessMode)}><option value="participate">Participate</option><option value="read">Read only</option></select></label>
            <label className="space-y-1 font-mono text-xs text-ink-muted">Turns<Input inputMode="numeric" value={maxTurns} onChange={(event) => setMaxTurns(event.target.value)} /></label>
            <label className="space-y-1 font-mono text-xs text-ink-muted">Participant duration (hours)<Input inputMode="numeric" value={durationHours} onChange={(event) => setDurationHours(event.target.value)} /></label>
            <label className="space-y-1 font-mono text-xs text-ink-muted">Invitation expiry (days)<Input inputMode="numeric" value={expiryDays} onChange={(event) => setExpiryDays(event.target.value)} /></label>
            <label className="space-y-1 font-mono text-xs text-ink-muted">Token budget (reported)<Input inputMode="numeric" value={maxTokens} onChange={(event) => setMaxTokens(event.target.value)} /></label>
            <label className="space-y-1 font-mono text-xs text-ink-muted">Cost budget USD (reported)<Input inputMode="decimal" value={maxCostUsd} onChange={(event) => setMaxCostUsd(event.target.value)} /></label>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={busy}>Create invitation</Button>
            <span className="font-mono text-[0.68rem] text-ink-faint">Hard enforcement: participant duration and turns.</span>
          </div>
        </form>

        {joinUrl && (
          <div className="rounded-lg border border-accent/40 bg-accent/10 p-3">
            <p className="font-mono text-xs text-accent-strong">New invitation link</p>
            <div className="mt-2 flex gap-2">
              <input className="field min-w-0 flex-1 font-mono text-xs" value={joinUrl} readOnly aria-label="Invitation link" />
              <Button type="button" variant="secondary" size="sm" onClick={copyLink}>Copy</Button>
            </div>
          </div>
        )}

        <section aria-labelledby="session-invitations-heading">
          <h2 id="session-invitations-heading" className="font-display text-sm font-semibold text-ink">Invitations ({activeInvitations.length} active)</h2>
          <div className="mt-2 space-y-2">
            {invitations.length === 0 ? <p className="font-mono text-xs text-ink-faint">No invitations yet.</p> : invitations.map((invitation) => (
              <div key={invitation.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-subtle bg-surface-raised/50 px-3 py-2">
                <span className="min-w-24 flex-1 font-body text-sm text-ink">Guest · {invitation.displayName}</span>
                <span className="badge badge-subtle font-mono text-[0.65rem]">{invitation.accessMode === "read" ? "Read" : "Participate"}</span>
                <span className={`font-mono text-[0.65rem] ${invitation.status === "active" ? "text-accent-strong" : "text-ink-faint"}`}>{invitation.status} · {invitation.participantCount} joined</span>
                <span className="font-mono text-[0.62rem] text-ink-faint">until {dateLabel(invitation.expiresAt)}</span>
                {invitation.status === "active" && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void toggleInvitation(invitation)}>Toggle access</Button>}
                {invitation.status === "active" && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void revokeInvitation(invitation.id)}>Revoke</Button>}
              </div>
            ))}
          </div>
        </section>

        <section aria-labelledby="session-participants-heading">
          <h2 id="session-participants-heading" className="font-display text-sm font-semibold text-ink">Participants ({participants.length})</h2>
          <div className="mt-2 space-y-2">
            {participants.length === 0 ? <p className="font-mono text-xs text-ink-faint">No admitted participants yet.</p> : participants.map((participant) => {
              const identity = participant.identity.kind === "guest" ? `Guest · ${participant.displayName}` : participant.identity.githubLogin || participant.identity.email || participant.displayName;
              return (
                <div key={participant.participantId} className="flex flex-wrap items-center gap-2 rounded-lg border border-edge-subtle bg-surface-raised/50 px-3 py-2">
                  <span className="min-w-32 flex-1 font-body text-sm text-ink">{identity}</span>
                  <span className={`font-mono text-[0.65rem] ${participant.presence.status === "online" ? "text-accent-strong" : participant.presence.status === "away" ? "text-warning-strong" : "text-ink-faint"}`}>{participant.presence.status}</span>
                  <span className="font-mono text-[0.62rem] text-ink-faint">{participant.status} · {participant.accessMode} · {participant.provenance} · {participant.usage.turns} turns</span>
                  <span className="font-mono text-[0.62rem] text-ink-faint">joined {dateLabel(participant.joinedAt)} · last active {dateLabel(participant.lastActiveAt)}</span>
                  {participant.provenance === "invitation" && participant.status === "active" && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void revokeParticipant(participant.participantId)}>Revoke</Button>}
                </div>
              );
            })}
          </div>
        </section>
        {error && <p className="font-mono text-xs text-danger" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
