import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useWorkspace } from "../workspace";
import { useLiveSocket } from "../liveSocket";
import { Badge, Button, Card, StatPlate, SectionHead } from "../ui";
import { useT } from "../i18n";
import { AddPeonDialog } from "../components/AddPeonDialog";

// Fallback shapes (only used when the socket is disconnected).
interface WsPeon {
  peonId: string;
  name: string | null;
  online?: boolean;
  status?: { activeSessionCount?: number; paused?: boolean } | null;
  lastError?: string | null;
}
// The poll fallback hits GET /workspaces/:wsId/sessions → the same SessionIndexRow
// the socket streams (peonId/sessionId, NOT id/peonName).
interface WsSession {
  peonId: string;
  sessionId: string;
  status?: string | null;
  title?: string | null;
  projectKey?: string | null;
}
interface Member {
  userId: string;
  email: string;
  role: string;
}
interface Invite {
  id: string;
  token: string;
  role: string;
  expiresAt: number | null;
}

type UIPeon = { peonId: string; name: string | null; online: boolean; active: number; lastError: string | null };
type UISession = { peonId: string | null; sessionId: string; title: string; status: string | null; sub: string };

export function Dashboard() {
  const t = useT();
  const { current } = useWorkspace();
  const { connected, peons: livePeons, sessions: liveSessions } = useLiveSocket();

  const [fbPeons, setFbPeons] = useState<WsPeon[]>([]);
  const [fbSessions, setFbSessions] = useState<WsSession[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [showAddPeon, setShowAddPeon] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const wsId = current?.id;
  const connectedRef = useRef(connected);
  connectedRef.current = connected;

  async function load() {
    if (!wsId) return;
    try {
      const base = `/workspaces/${wsId}`;
      const [mem] = await Promise.all([api<{ members: Member[] }>(`${base}/members`)]);
      setMembers(mem.members);
      // Peons/sessions come live over the socket; only poll them as a fallback.
      if (!connectedRef.current) {
        const [status, sess] = await Promise.all([api<{ peons: WsPeon[] }>(`${base}/status`), api<{ sessions: WsSession[] }>(`${base}/sessions`)]);
        setFbPeons(status.peons);
        setFbSessions(sess.sessions);
      }
      if (current?.role === "owner") {
        try {
          const inv = await api<{ invites: Invite[] }>(`${base}/invites`);
          setInvites(inv.invites);
        } catch {
          /* transient — keep last-known invites */
        }
      } else {
        setInvites([]);
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.loadFailed"));
    }
  }

  useEffect(() => {
    setFbPeons([]);
    setFbSessions([]);
    setMembers([]);
    setInvites([]);
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  async function createInviteLink() {
    if (!wsId) return;
    try {
      await api(`/workspaces/${wsId}/invites`, { method: "POST" });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("error.inviteFailed"));
    }
  }
  async function revokeInviteLink(id: string) {
    if (!wsId) return;
    try {
      await api(`/workspaces/${wsId}/invites/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("error.inviteFailed"));
    }
  }
  const inviteUrl = (token: string) => `${window.location.origin}/join/${token}`;
  function flashCopied(token: string) {
    setCopied(token);
    window.setTimeout(() => setCopied((c) => (c === token ? null : c)), 1500);
  }
  async function copyInvite(token: string) {
    try {
      await navigator.clipboard.writeText(inviteUrl(token));
      flashCopied(token);
    } catch {
      /* clipboard unavailable */
    }
  }
  async function shareInvite(token: string) {
    const url = inviteUrl(token);
    if (navigator.share) {
      try {
        await navigator.share({ title: t("invites.shareTitle"), url });
        return;
      } catch {
        /* cancelled — fall through to copy */
      }
    }
    copyInvite(token);
  }

  // Unify the socket (primary) and poll (fallback) into one render shape.
  const peons: UIPeon[] = connected
    ? livePeons.map((p) => ({ peonId: p.peonId, name: p.name, online: p.online, active: p.load?.activeSessions ?? 0, lastError: null }))
    : fbPeons.map((p) => ({ peonId: p.peonId, name: p.name, online: !!p.online, active: p.status?.activeSessionCount ?? 0, lastError: p.lastError ?? null }));
  const nameOf = (id: string) => peons.find((p) => p.peonId === id)?.name || id;
  const sessions: UISession[] = connected
    ? liveSessions.map((s) => ({ peonId: s.peonId, sessionId: s.sessionId, title: s.title || s.sessionId, status: s.status ?? null, sub: `${s.projectKey || "—"} · ${nameOf(s.peonId)}` }))
    : fbSessions.map((s) => ({ peonId: s.peonId, sessionId: s.sessionId, title: s.title || s.sessionId, status: s.status ?? null, sub: `${s.projectKey || "—"} · ${nameOf(s.peonId)}` }));

  const onlineCount = peons.filter((p) => p.online).length;
  const activeCount = peons.reduce((n, p) => n + (p.online ? p.active : 0), 0);
  const needsHuman = sessions.filter((s) => s.status === "needs_human").length;

  return (
    <>
      {error && <p className="reveal mb-6 border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {error}</p>}

      {/* Overview */}
      <section className="reveal mb-4 flex items-center justify-between" style={{ animationDelay: "20ms" }}>
        <span className="flex items-center gap-2 font-mono text-[0.7rem] uppercase tracking-[0.14em] text-bone-dim">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "bg-fel shadow-[0_0_7px_var(--color-fel)]" : "bg-forge"}`} />
          {connected ? t("live.on") : t("live.reconnecting")}
        </span>
      </section>
      <section className="reveal mb-10 grid grid-cols-2 gap-3 sm:grid-cols-4" style={{ animationDelay: "40ms" }}>
        <StatPlate value={`${onlineCount}/${peons.length}`} label={t("stat.peonsOnline")} />
        <StatPlate value={activeCount} label={t("stat.activeSessions")} />
        <StatPlate value={needsHuman} label={t("stat.needsAttention")} tone={needsHuman > 0 ? "forge" : "bone"} />
        <StatPlate value={members.length} label={t("stat.members")} tone="bone" />
      </section>

      {/* Peons */}
      <section className="reveal mb-10" style={{ animationDelay: "90ms" }}>
        <SectionHead
          title={t("section.peons")}
          right={
            <Button size="sm" onClick={() => setShowAddPeon(true)}>
              {t("peons.connect")}
            </Button>
          }
        />
        <Card>
          {peons.length === 0 ? (
            <p className="p-8 text-center font-mono text-sm text-bone-faint">{t("peons.empty")}</p>
          ) : (
            <ul className="divide-y divide-iron-800">
              {peons.map((p) => (
                <li key={p.peonId}>
                  <Link to={`/peons/${p.peonId}`} className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-fel/[0.03]">
                    <div className="min-w-0">
                      <div className="font-display text-sm font-semibold tracking-wide text-bone">{p.name || t("peons.unnamed")}</div>
                      {!p.online && p.lastError && <div className="mt-1 font-mono text-xs text-blood/80">{p.lastError}</div>}
                    </div>
                    <div className="flex flex-none items-center gap-4">
                      {p.online && (
                        <span className={`hidden items-center gap-1.5 font-mono text-[0.7rem] tabular-nums sm:flex ${p.active > 0 ? "text-forge" : "text-bone-faint"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${p.active > 0 ? "bg-forge shadow-[0_0_7px_var(--color-forge)]" : "bg-iron-700"}`} />
                          {t("peons.active", { n: p.active })}
                        </span>
                      )}
                      <Badge tone={p.online ? "green" : "red"}>{p.online ? t("peons.online") : t("peons.offline")}</Badge>
                      <span className="text-bone-faint" aria-hidden>
                        ›
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      {/* Sessions */}
      <section className="reveal mb-10" style={{ animationDelay: "140ms" }}>
        <SectionHead title={t("section.sessions")} />
        <Card>
          {sessions.length === 0 ? (
            <p className="p-8 text-center font-mono text-sm text-bone-faint">{t("sessions.empty")}</p>
          ) : (
            <ul className="divide-y divide-iron-800">
              {sessions.map((s) => {
                const row = (
                  <div className="flex items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-fel/[0.03]">
                    <div className="min-w-0">
                      <div className="truncate font-display text-sm font-medium text-bone">{s.title}</div>
                      <div className="mt-0.5 font-mono text-xs text-bone-faint">{s.sub}</div>
                    </div>
                    <Badge tone={s.status === "running" ? "green" : s.status === "needs_human" ? "amber" : "neutral"}>
                      {s.status ? s.status.replace(/_/g, " ") : t("status.unknown")}
                    </Badge>
                  </div>
                );
                return (
                  <li key={`${s.peonId}:${s.sessionId}`}>
                    {s.peonId ? <Link to={`/peons/${s.peonId}/sessions/${s.sessionId}`}>{row}</Link> : row}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </section>

      {/* Members */}
      <section className="reveal" style={{ animationDelay: "190ms" }}>
        <SectionHead title={t("section.members")} />
        <Card>
          <ul className="divide-y divide-iron-800">
            {members.map((m) => (
              <li key={m.userId} className="flex items-center justify-between px-5 py-3">
                <span className="font-mono text-sm text-bone">{m.email}</span>
                <Badge tone={m.role === "owner" ? "amber" : "neutral"}>{m.role === "owner" ? t("role.owner") : m.role}</Badge>
              </li>
            ))}
          </ul>
        </Card>

        {current?.role === "owner" && (
          <div className="mt-6">
            <SectionHead
              title={t("invites.title")}
              right={
                <Button size="sm" onClick={createInviteLink}>
                  {t("invites.new")}
                </Button>
              }
            />
            <Card>
              {invites.length === 0 ? (
                <p className="p-8 text-center font-mono text-sm text-bone-faint">{t("invites.empty")}</p>
              ) : (
                <ul className="divide-y divide-iron-800">
                  {invites.map((inv) => (
                    <li key={inv.id} className="flex items-center justify-between gap-3 px-5 py-3">
                      <div className="min-w-0">
                        <div className="truncate font-mono text-xs text-fel-bright">{inviteUrl(inv.token)}</div>
                        <div className="mt-0.5 font-mono text-[0.65rem] text-bone-faint">
                          {inv.role === "owner" ? t("role.owner") : t("role.member")}
                          {inv.expiresAt ? (
                            <>
                              {" "}
                              <span className="text-iron-600">·</span> {t("invites.expires", { date: new Date(inv.expiresAt).toLocaleDateString() })}
                            </>
                          ) : null}
                        </div>
                      </div>
                      <div className="flex flex-none items-center gap-2">
                        <button className="btn-ghost" onClick={() => copyInvite(inv.token)}>
                          {copied === inv.token ? t("invites.copied") : t("invites.copy")}
                        </button>
                        <button className="btn-ghost" onClick={() => shareInvite(inv.token)}>
                          {t("invites.share")}
                        </button>
                        <button className="btn-ghost hover:!text-blood" onClick={() => revokeInviteLink(inv.id)}>
                          {t("invites.revoke")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </section>

      {showAddPeon && wsId && <AddPeonDialog workspaceId={wsId} onClose={() => setShowAddPeon(false)} onAdded={load} />}
    </>
  );
}
