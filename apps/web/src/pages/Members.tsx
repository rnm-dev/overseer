import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router";
import { ArrowLeft, Check, Clock3, Copy, ShieldCheck, Trash2, UserPlus, Users } from "lucide-react";
import { api, json } from "../api";
import { useT } from "../i18n";
import { Avatar } from "../components/Avatar";
import { Badge, Button, Card, ConfirmationDialog, Input, OverseerWordmark } from "../ui";
import { useWorkspace } from "../workspace";

type Role = "owner" | "member";

interface Member {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  role: Role;
  addedAt: number;
}

interface Invite {
  id: string;
  token: string;
  inviteeLabel: string | null;
  role: Role;
  createdAt: number;
  expiresAt: number | null;
}

interface ResourceAccess {
  peonIds: string[];
  projects: { peonId: string; projectKey: string; projectId?: string | null }[];
}

interface AccessPeon {
  peonId: string;
  name: string | null;
  online: boolean;
  projects: { key: string; projectId?: string | null }[];
}

export function Members() {
  const t = useT();
  const { workspaceId = "" } = useParams();
  const { workspaces, ready: workspacesReady } = useWorkspace();
  const workspace = workspaces.find((item) => item.id === workspaceId);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [label, setLabel] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("member");
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessMember, setAccessMember] = useState<string | null>(null);
  const [access, setAccess] = useState<ResourceAccess | null>(null);
  const [accessPeons, setAccessPeons] = useState<AccessPeon[]>([]);
  const [accessBusy, setAccessBusy] = useState(false);
  const [memberToRemove, setMemberToRemove] = useState<Member | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId || workspace?.role !== "owner") return;
    setLoading(true);
    try {
      const [memberResult, inviteResult] = await Promise.all([
        api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`),
        api<{ invites: Invite[] }>(`/workspaces/${workspaceId}/invites`),
      ]);
      setMembers(memberResult.members);
      setInvites(inviteResult.invites);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t, workspace?.role, workspaceId]);

  useEffect(() => { void load(); }, [load]);

  if (!workspacesReady) return <div className="grid min-h-screen place-items-center"><div className="loading-spinner" /></div>;
  if (!workspace || workspace.role !== "owner") return <Navigate to="/" replace />;

  const inviteUrl = (token: string) => `${window.location.origin}/join/${token}`;

  async function createInvite(event: FormEvent) {
    event.preventDefault();
    const inviteeLabel = label.trim();
    if (!inviteeLabel) return;
    setBusy("create");
    setError(null);
    try {
      const result = await api<{ invite: Invite }>(`/workspaces/${workspaceId}/invites`, json({ inviteeLabel, role: inviteRole }));
      setInvites((current) => [result.invite, ...current]);
      setLabel("");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.inviteFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function changeRole(member: Member, role: Role) {
    setBusy(member.userId);
    setError(null);
    try {
      await api(`/workspaces/${workspaceId}/members/${encodeURIComponent(member.userId)}`, { ...json({ role }), method: "PATCH" });
      setMembers((current) => current.map((item) => item.userId === member.userId ? { ...item, role } : item));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("members.roleFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function removeMember(member: Member) {
    setBusy(member.userId);
    setError(null);
    try {
      await api(`/workspaces/${workspaceId}/members/${encodeURIComponent(member.userId)}`, { method: "DELETE" });
      setMembers((current) => current.filter((item) => item.userId !== member.userId));
      setMemberToRemove(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("members.removeFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function revokeInvite(invite: Invite) {
    setBusy(invite.id);
    setError(null);
    try {
      await api(`/workspaces/${workspaceId}/invites/${invite.id}`, { method: "DELETE" });
      setInvites((current) => current.filter((item) => item.id !== invite.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("error.inviteFailed"));
    } finally {
      setBusy(null);
    }
  }

  async function copyInvite(invite: Invite) {
    try {
      await navigator.clipboard.writeText(inviteUrl(invite.token));
      setCopied(invite.id);
      window.setTimeout(() => setCopied((value) => value === invite.id ? null : value), 1500);
    } catch {
      setError(t("invites.copyFailed"));
    }
  }

  async function openAccess(member: Member) {
    if (accessMember === member.userId) {
      setAccessMember(null);
      return;
    }
    setAccessMember(member.userId);
    setAccess(null);
    setAccessBusy(true);
    setError(null);
    try {
      const [accessResult, peonResult] = await Promise.all([
        api<{ access: ResourceAccess }>(`/workspaces/${workspaceId}/members/${encodeURIComponent(member.userId)}/access`),
        api<{ peons: Omit<AccessPeon, "projects">[] }>(`/workspaces/${workspaceId}/peons`),
      ]);
      const peons = await Promise.all(peonResult.peons.map(async (peon) => {
        try {
          const result = await api<{ projects: { key: string; projectId?: string | null }[] }>(`/workspaces/${workspaceId}/peons/${encodeURIComponent(peon.peonId)}/projects`);
          return { ...peon, projects: result.projects ?? [] };
        } catch {
          return { ...peon, projects: [] };
        }
      }));
      setAccess(accessResult.access);
      setAccessPeons(peons);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("members.accessLoadFailed"));
      setAccessMember(null);
    } finally {
      setAccessBusy(false);
    }
  }

  function togglePeon(peonId: string, enabled: boolean) {
    setAccess((current) => current ? {
      peonIds: enabled ? [...new Set([...current.peonIds, peonId])] : current.peonIds.filter((id) => id !== peonId),
      projects: enabled ? current.projects : current.projects.filter((item) => item.peonId !== peonId),
    } : current);
  }

  function toggleProject(peonId: string, projectKey: string, projectId: string | null | undefined, enabled: boolean) {
    setAccess((current) => {
      if (!current) return current;
      const projects = enabled
        ? [...current.projects.filter((item) => item.peonId !== peonId || (projectId ? item.projectId !== projectId : item.projectKey !== projectKey)), { peonId, projectKey, projectId: projectId ?? null }]
        : current.projects.filter((item) => item.peonId !== peonId || (projectId ? item.projectId !== projectId : item.projectKey !== projectKey));
      return { peonIds: enabled ? [...new Set([...current.peonIds, peonId])] : current.peonIds, projects };
    });
  }

  async function saveAccess() {
    if (!accessMember || !access) return;
    setAccessBusy(true);
    setError(null);
    try {
      await api(`/workspaces/${workspaceId}/members/${encodeURIComponent(accessMember)}/access`, { ...json(access), method: "PUT" });
      setAccessMember(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("members.accessSaveFailed"));
    } finally {
      setAccessBusy(false);
    }
  }

  return (
    <div className="min-h-screen px-4 pb-24 pt-5 sm:px-6 sm:pt-8">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8">
          <Link to={`/workspaces/${encodeURIComponent(workspaceId)}`} className="mb-6 inline-flex items-center gap-2 font-mono text-xs text-ink-faint transition-colors hover:text-ink">
            <ArrowLeft size={14} aria-hidden /> {t("members.back")}
          </Link>
          <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <div className="mb-3"><OverseerWordmark /></div>
              <h1 className="font-display text-2xl font-bold tracking-tight text-ink sm:text-3xl">{t("members.title")}</h1>
              <p className="mt-1.5 font-mono text-xs text-ink-faint">{workspace.name}</p>
            </div>
            <div className="flex gap-2">
              <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-raised px-3 py-2 font-mono text-xs text-ink-muted">
                <Users size={14} className="text-accent-strong" aria-hidden />
                <strong className="font-display text-sm text-ink">{members.length}</strong> {t("members.active")}
              </div>
              <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-raised px-3 py-2 font-mono text-xs text-ink-muted">
                <Clock3 size={14} className="text-warning-strong" aria-hidden />
                <strong className="font-display text-sm text-ink">{invites.length}</strong> {t("members.pending")}
              </div>
            </div>
          </div>
        </header>

        {error && <p className="mb-5 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 font-mono text-xs text-danger">⚠ {error}</p>}

        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_19rem]">
          <div className="space-y-5">
            <Card className="overflow-hidden">
              <div className="flex items-center justify-between border-b border-edge px-5 py-4">
                <div>
                  <h2 className="font-display text-sm font-semibold text-ink">{t("section.members")}</h2>
                  <p className="mt-0.5 font-mono text-[0.68rem] text-ink-faint">{t("members.count", { n: members.length })}</p>
                </div>
                <ShieldCheck size={18} className="text-accent/70" aria-hidden />
              </div>
              {loading ? (
                <div className="grid min-h-40 place-items-center"><div className="loading-spinner" /></div>
              ) : (
                <ul className="divide-y divide-iron-800">
                  {members.map((member) => (
                    <li key={member.userId} className="transition-colors hover:bg-surface-hover/20">
                    <div className="group flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-3.5">
                        <Avatar src={member.avatarUrl} label={member.githubLogin || member.email} size="xl" className="border-edge-strong" />
                        <div className="min-w-0">
                          <p className="truncate font-display text-sm font-semibold text-ink">{member.githubLogin ? `@${member.githubLogin}` : member.email}</p>
                          {member.githubLogin && <p className="mt-0.5 truncate font-mono text-[0.7rem] text-ink-faint">{member.email}</p>}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 self-end sm:self-auto">
                        {member.role === "member" && <button type="button" className={`h-9 rounded-md px-3 font-display text-xs transition-colors ${accessMember === member.userId ? "bg-accent/10 text-accent-strong" : "text-ink-muted hover:bg-surface-hover hover:text-ink"}`} onClick={() => void openAccess(member)}>{t("members.access")}</button>}
                        <select style={{ width: 124 }} className="field !py-2 !text-xs" aria-label={t("members.roleFor", { name: member.githubLogin || member.email })} disabled={busy === member.userId} value={member.role} onChange={(event) => void changeRole(member, event.target.value as Role)}>
                          <option value="member">{t("role.member")}</option>
                          <option value="owner">{t("role.owner")}</option>
                        </select>
                        {member.role === "member" && <button type="button" title={t("action.remove")} aria-label={t("members.removeConfirm", { name: member.githubLogin || member.email })} className="grid h-9 w-9 place-items-center rounded-md text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40" disabled={busy === member.userId} onClick={() => setMemberToRemove(member)}><Trash2 size={15} aria-hidden /></button>}
                      </div>
                    </div>
                    {accessMember === member.userId && <div className="border-t border-edge bg-surface/35 px-5 py-5">
                      <div className="mb-4 flex items-start justify-between gap-4">
                        <div><h3 className="font-display text-sm font-semibold text-ink">{t("members.resourceAccess")}</h3><p className="mt-1 font-mono text-[0.68rem] text-ink-faint">{t("members.resourceAccessHint")}</p></div>
                        <button type="button" className="btn-ghost" onClick={() => setAccessMember(null)}>{t("action.cancel")}</button>
                      </div>
                      {accessBusy && !access ? <div className="loading-spinner" /> : access && <div className="space-y-3">
                        {accessPeons.length === 0 ? <p className="font-mono text-xs text-ink-faint">{t("members.noPeons")}</p> : accessPeons.map((peon) => {
                          const peonEnabled = access.peonIds.includes(peon.peonId);
                          return <div key={peon.peonId} className="surface surface--subtle">
                            <label className="flex cursor-pointer items-center gap-3 px-4 py-3">
                              <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={peonEnabled} onChange={(event) => togglePeon(peon.peonId, event.target.checked)} />
                              <span className="h-2 w-2 rounded-full bg-surface-disabled" />
                              <span className="font-display text-sm font-semibold text-ink">{peon.name || peon.peonId}</span>
                              <span className="ml-auto font-mono text-[0.65rem] text-ink-faint">{t("members.peonAccess")}</span>
                            </label>
                            {peonEnabled && <div className="border-t border-edge px-4 py-3">
                              <p className="mb-2 font-display text-[0.6rem] font-semibold uppercase tracking-[0.14em] text-ink-faint">{t("peon.tab.projects")}</p>
                              {peon.projects.length === 0 ? <p className="font-mono text-[0.68rem] text-ink-faint">{t("peon.projects.empty")}</p> : <div className="grid gap-2 sm:grid-cols-2">{peon.projects.map((project) => {
                                const checked = access.projects.some((item) => item.peonId === peon.peonId && (project.projectId ? item.projectId === project.projectId : item.projectKey === project.key));
                                return <label key={project.projectId ?? project.key} className="flex cursor-pointer items-center gap-2 rounded-md border border-edge px-3 py-2 font-mono text-xs text-ink-muted hover:border-edge-strong hover:text-ink"><input type="checkbox" className="accent-[var(--color-accent)]" checked={checked} onChange={(event) => toggleProject(peon.peonId, project.key, project.projectId, event.target.checked)} /><span className="truncate">{project.key}</span></label>;
                              })}</div>}
                            </div>}
                          </div>;
                        })}
                        <div className="flex justify-end pt-1"><Button onClick={() => void saveAccess()} disabled={accessBusy}>{accessBusy ? t("peon.settings.saving") : t("members.saveAccess")}</Button></div>
                      </div>}
                    </div>}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {!loading && invites.length > 0 && <Card className="overflow-hidden">
              <div className="border-b border-edge px-5 py-4">
                <h2 className="font-display text-sm font-semibold text-ink">{t("members.pendingTitle")}</h2>
                <p className="mt-0.5 font-mono text-[0.68rem] text-ink-faint">{t("members.pendingHint")}</p>
              </div>
              <ul className="divide-y divide-iron-800">
                {invites.map((invite) => (
                  <li key={invite.id} className="flex flex-col gap-3 px-5 py-4 transition-colors hover:bg-surface-hover/20 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="h-2 w-2 flex-none rounded-full bg-warning-strong shadow-[0_0_8px_rgba(217,148,65,0.35)]" />
                        <p className="truncate font-display text-sm font-semibold text-ink">{invite.inviteeLabel || t("members.pending")}</p>
                        <Badge tone="amber">{invite.role === "owner" ? t("role.owner") : t("role.member")}</Badge>
                      </div>
                      <p className="mt-1.5 truncate pl-4 font-mono text-[0.68rem] text-ink-faint">…/join/{invite.token}</p>
                    </div>
                    <div className="flex items-center gap-1 self-end sm:self-auto">
                      <button type="button" className="inline-flex h-9 items-center gap-2 rounded-md px-3 font-display text-xs text-ink-muted transition-colors hover:bg-accent/10 hover:text-accent-strong" onClick={() => void copyInvite(invite)}>
                        {copied === invite.id ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
                        {copied === invite.id ? t("invites.copied") : t("invites.copy")}
                      </button>
                      <button type="button" title={t("invites.revoke")} aria-label={t("invites.revoke")} className="grid h-9 w-9 place-items-center rounded-md text-ink-faint transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-40" disabled={busy === invite.id} onClick={() => void revokeInvite(invite)}><Trash2 size={15} aria-hidden /></button>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>}
          </div>

          <Card className="p-5 lg:sticky lg:top-8">
            <div className="mb-5 grid h-10 w-10 place-items-center rounded-lg border border-accent/20 bg-accent/10 text-accent-strong"><UserPlus size={19} aria-hidden /></div>
            <h2 className="font-display text-base font-semibold text-ink">{t("members.inviteTitle")}</h2>
            <p className="mt-1.5 font-mono text-[0.7rem] leading-relaxed text-ink-faint">{t("members.inviteHint")}</p>
            <form className="mt-5 space-y-4" onSubmit={createInvite}>
              <label className="block">
                <span className="mb-1.5 block font-display text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-ink-muted">{t("members.person")}</span>
                <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("members.invitePlaceholder")} autoFocus />
              </label>
              <label className="block">
                <span className="mb-1.5 block font-display text-[0.62rem] font-semibold uppercase tracking-[0.14em] text-ink-muted">{t("members.role")}</span>
                <select className="field" value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Role)}>
                  <option value="member">{t("role.member")}</option>
                  <option value="owner">{t("role.owner")}</option>
                </select>
              </label>
              <Button className="!w-full !py-3" type="submit" disabled={!label.trim() || busy === "create"}>
                <UserPlus size={15} aria-hidden /> {busy === "create" ? t("members.inviting") : t("members.invite")}
              </Button>
            </form>
          </Card>
        </div>
      </div>
      {memberToRemove && (
        <ConfirmationDialog
          title={t("members.removeConfirm", { name: memberToRemove.githubLogin || memberToRemove.email })}
          confirmLabel={t("action.remove")}
          pendingLabel={t("members.removing")}
          pending={busy === memberToRemove.userId}
          onClose={() => setMemberToRemove(null)}
          onConfirm={() => void removeMember(memberToRemove)}
        />
      )}
    </div>
  );
}
