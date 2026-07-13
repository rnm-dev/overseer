import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, StatusDot } from "../ui";
import { useT } from "../i18n";
import type { PeonLite, Workspace } from "../workspace";
import { AddPeonDialog } from "./AddPeonDialog";

// author: Viktor
// One workspace on the fleet dashboard: its peons in a grid, plus lazy
// owner-only member/invite management tucked behind a toggle.

interface StatusPeon {
  peonId: string;
  name: string | null;
  online?: boolean;
  status?: { activeSessionCount?: number; paused?: boolean } | null;
  lastError?: string | null;
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

export function WorkspaceSection({ workspace, peons }: { workspace: Workspace; peons: PeonLite[] }) {
  const t = useT();
  const wsId = workspace.id;
  const isOwner = workspace.role === "owner";

  const [status, setStatus] = useState<Record<string, StatusPeon>>({});
  const [showAddPeon, setShowAddPeon] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [confirmMemberRemoval, setConfirmMemberRemoval] = useState<string | null>(null);
  const [removingMember, setRemovingMember] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  const onlineCount = peons.filter((p) => status[p.peonId]?.online ?? p.online).length;

  // Active-session counts (+ live online / lastError) per peon, independent of
  // the single-workspace live socket so every workspace grid is equally fresh.
  useEffect(() => {
    let alive = true;
    const pull = () =>
      api<{ peons: StatusPeon[] }>(`/workspaces/${wsId}/status`)
        .then((r) => alive && setStatus(Object.fromEntries((r.peons ?? []).map((p) => [p.peonId, p]))))
        .catch(() => {});
    pull();
    const timer = window.setInterval(pull, 5000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [wsId]);

  async function loadAdmin() {
    if (!isOwner) return;
    try {
      const [mem, inv] = await Promise.all([
        api<{ members: Member[] }>(`/workspaces/${wsId}/members`),
        api<{ invites: Invite[] }>(`/workspaces/${wsId}/invites`),
      ]);
      setMembers(mem.members);
      setInvites(inv.invites);
    } catch {
      /* transient — keep last-known */
    }
  }
  useEffect(() => {
    if (showAdmin) loadAdmin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAdmin, wsId]);

  const inviteUrl = (token: string) => `${window.location.origin}/join/${token}`;
  async function createInviteLink() {
    try {
      await api(`/workspaces/${wsId}/invites`, { method: "POST" });
      loadAdmin();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("error.inviteFailed"));
    }
  }
  async function revokeInviteLink(id: string) {
    try {
      await api(`/workspaces/${wsId}/invites/${id}`, { method: "DELETE" });
      loadAdmin();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("error.inviteFailed"));
    }
  }
  async function removeWorkspaceMember(member: Member) {
    setRemovingMember(member.userId);
    setMemberError(null);
    try {
      await api(`/workspaces/${wsId}/members/${encodeURIComponent(member.userId)}`, { method: "DELETE" });
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      setConfirmMemberRemoval(null);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : t("members.removeFailed"));
    } finally {
      setRemovingMember(null);
    }
  }
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

  return (
    <section className="mb-9">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="flex items-baseline gap-2.5 font-display text-sm font-bold uppercase tracking-[0.14em] text-bone">
          {workspace.name}
          {peons.length > 0 && (
            <span className="font-mono text-[0.7rem] font-normal tracking-normal tabular-nums text-bone-faint">
              {onlineCount}/{peons.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {isOwner && (
            <button className="btn-ghost" onClick={() => setShowAdmin((v) => !v)}>
              {t("dashboard.wsAdmin")}
            </button>
          )}
          <Button size="sm" onClick={() => setShowAddPeon(true)}>
            {t("peons.connect")}
          </Button>
        </div>
      </div>

      {peons.length === 0 ? (
        <p className="warplate px-5 py-8 text-center font-mono text-sm text-bone-faint">{t("peons.empty")}</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {peons.map((p) => {
            const st = status[p.peonId];
            const online = st?.online ?? p.online;
            const active = st?.status?.activeSessionCount ?? 0;
            return (
              <li key={p.peonId}>
                <Link
                  to={`/peons/${p.peonId}`}
                  className="warplate flex h-full flex-col justify-between gap-3 px-4 py-3.5 transition-colors hover:border-fel/40 hover:bg-fel/[0.03]"
                >
                  <div className="flex items-start justify-between gap-2">
                    <StatusDot state={online ? "on" : "off"} />
                    <Badge tone={online ? "green" : "red"}>{online ? t("peons.online") : t("peons.offline")}</Badge>
                  </div>
                  <div className="min-w-0">
                    <div className="truncate font-display text-sm font-semibold tracking-wide text-bone">{p.name || t("peons.unnamed")}</div>
                    {online ? (
                      <div className={`mt-0.5 flex items-center gap-1.5 font-mono text-xs tabular-nums ${active > 0 ? "text-forge" : "text-bone-faint"}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${active > 0 ? "bg-forge shadow-[0_0_7px_var(--color-forge)]" : "bg-iron-700"}`} />
                        {t("peons.active", { n: active })}
                      </div>
                    ) : st?.lastError ? (
                      <div className="mt-0.5 truncate font-mono text-xs text-blood/80">{st.lastError}</div>
                    ) : null}
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {isOwner && showAdmin && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="warplate px-5 py-4">
            <h3 className="mb-3 rune text-xs text-bone">{t("section.members")}</h3>
            {memberError && <p className="mb-2 font-mono text-xs text-blood">⚠ {memberError}</p>}
            <ul className="divide-y divide-iron-800">
              {members.map((m) => (
                <li key={m.userId} className="flex items-center justify-between gap-2 py-2">
                  <span className="truncate font-mono text-xs text-bone">{m.email}</span>
                  <div className="flex flex-none items-center gap-1.5">
                    <Badge tone={m.role === "owner" ? "amber" : "neutral"}>{m.role === "owner" ? t("role.owner") : t("role.member")}</Badge>
                    {m.role !== "owner" && (confirmMemberRemoval === m.userId ? (
                      <>
                        <button className="btn-ghost" disabled={removingMember === m.userId} onClick={() => setConfirmMemberRemoval(null)}>
                          {t("action.cancel")}
                        </button>
                        <button className="btn-ghost hover:!text-blood" disabled={removingMember === m.userId} onClick={() => removeWorkspaceMember(m)}>
                          {removingMember === m.userId ? t("members.removing") : t("action.remove")}
                        </button>
                      </>
                    ) : (
                      <button className="btn-ghost hover:!text-blood" onClick={() => { setMemberError(null); setConfirmMemberRemoval(m.userId); }}>
                        {t("action.remove")}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="warplate px-5 py-4">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="rune text-xs text-bone">{t("invites.title")}</h3>
              <button className="btn-ghost" onClick={createInviteLink}>
                {t("invites.new")}
              </button>
            </div>
            {invites.length === 0 ? (
              <p className="py-4 text-center font-mono text-xs text-bone-faint">{t("invites.empty")}</p>
            ) : (
              <ul className="divide-y divide-iron-800">
                {invites.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[0.7rem] text-fel-bright">{inviteUrl(inv.token)}</div>
                      <div className="mt-0.5 font-mono text-[0.6rem] text-bone-faint">{inv.role === "owner" ? t("role.owner") : t("role.member")}</div>
                    </div>
                    <div className="flex flex-none items-center gap-1.5">
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
          </div>
        </div>
      )}

      {showAddPeon && <AddPeonDialog workspaceId={wsId} onClose={() => setShowAddPeon(false)} onAdded={() => setShowAddPeon(false)} />}
    </section>
  );
}
