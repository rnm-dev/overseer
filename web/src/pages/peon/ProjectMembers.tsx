import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router-dom";
import { Check, Users } from "lucide-react";
import { api, json } from "../../api";
import { useT } from "../../i18n";
import { Badge, Card } from "../../ui";
import { usePeon } from "./context";
import { Avatar } from "../../components/Avatar";
import { ProjectTabs } from "./ProjectTabs";
import { ProjectPageHeader } from "./ProjectPageHeader";

interface Member {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  role: "owner" | "member";
}

interface Access {
  peonIds: string[];
  projects: { peonId: string; projectKey: string; projectId?: string | null }[];
}

export function ProjectMembers() {
  const t = useT();
  const { key = "" } = useParams();
  const { peon, wsId, isOwner } = usePeon();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [accessByMember, setAccessByMember] = useState<Record<string, Access>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    Promise.all([
      api<{ members: Member[] }>(`/workspaces/${wsId}/members`),
      api<{ projectId?: string | null }>(`/workspaces/${wsId}/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}`),
    ])
      .then(async ([result, project]) => {
        const regular = result.members.filter((member) => member.role === "member");
        const entries = await Promise.all(regular.map(async (member) => {
          const response = await api<{ access: Access }>(`/workspaces/${wsId}/members/${encodeURIComponent(member.userId)}/access`);
          return [member.userId, response.access] as const;
        }));
        if (!alive) return;
        setMembers(result.members);
        setProjectId(project.projectId ?? null);
        setAccessByMember(Object.fromEntries(entries));
      })
      .catch((err) => alive && setError(err instanceof Error ? err.message : t("members.accessLoadFailed")));
    return () => { alive = false; };
  }, [isOwner, key, peon.peonId, t, wsId]);

  if (!isOwner) return <Navigate to={`/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}`} replace />;

  const regularMembers = members?.filter((member) => member.role === "member") ?? [];
  const owners = members?.filter((member) => member.role === "owner") ?? [];

  async function setProjectAccess(member: Member, enabled: boolean) {
    const current = accessByMember[member.userId];
    if (!current) return;
    setBusy(member.userId);
    setSaved(null);
    setError(null);
    const projects = enabled
      ? [...current.projects.filter((item) => item.peonId !== peon.peonId || (projectId ? item.projectId !== projectId : item.projectKey !== key)), { peonId: peon.peonId, projectKey: key, projectId }]
      : current.projects.filter((item) => item.peonId !== peon.peonId || (projectId ? item.projectId !== projectId : item.projectKey !== key));
    const next: Access = {
      peonIds: enabled ? [...new Set([...current.peonIds, peon.peonId])] : current.peonIds,
      projects,
    };
    try {
      await api(`/workspaces/${wsId}/members/${encodeURIComponent(member.userId)}/access`, { ...json(next), method: "PUT" });
      setAccessByMember((value) => ({ ...value, [member.userId]: next }));
      setSaved(member.userId);
      window.setTimeout(() => setSaved((value) => value === member.userId ? null : value), 1400);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("members.accessSaveFailed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <ProjectPageHeader />
      <ProjectTabs />
      {error && <p className="rounded-md border border-blood/30 bg-blood/5 px-4 py-3 font-mono text-xs text-blood">⚠ {error}</p>}
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3 border-b border-iron-800 px-5 py-4">
          <div className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-fel/10 text-fel-bright"><Users size={17} aria-hidden /></div>
          <div><h2 className="font-display text-sm font-semibold text-bone">{t("proj.members.title")}</h2><p className="mt-1 font-mono text-[0.7rem] text-bone-faint">{t("proj.members.hint")}</p></div>
        </div>
        {members === null ? <div className="grid min-h-40 place-items-center"><div className="forge-spin" /></div> : <>
          {owners.length > 0 && <div className="border-b border-iron-800 bg-iron-950/25 px-5 py-3"><p className="font-mono text-[0.68rem] text-bone-faint">{t("proj.members.owners", { n: owners.length })}</p></div>}
          {regularMembers.length === 0 ? <p className="p-8 text-center font-mono text-sm text-bone-faint">{t("proj.members.empty")}</p> : <ul className="divide-y divide-iron-800">
            {regularMembers.map((member) => {
              const access = accessByMember[member.userId];
              const checked = access?.projects.some((item) => item.peonId === peon.peonId && (projectId ? item.projectId === projectId : item.projectKey === key)) ?? false;
              return <li key={member.userId} className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-iron-800/20">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar src={member.avatarUrl} label={member.githubLogin || member.email} size="lg" className="border-iron-700" />
                  <div className="min-w-0"><p className="truncate font-display text-sm font-semibold text-bone">{member.githubLogin ? `@${member.githubLogin}` : member.email}</p>{member.githubLogin && <p className="truncate font-mono text-[0.68rem] text-bone-faint">{member.email}</p>}</div>
                </div>
                <label className="flex cursor-pointer items-center gap-2.5">
                  {saved === member.userId && <Badge tone="green"><Check size={11} aria-hidden />{t("peon.settings.saved")}</Badge>}
                  <span className="font-display text-xs text-bone-dim">{checked ? t("proj.members.canAccess") : t("proj.members.noAccess")}</span>
                  <input type="checkbox" className="h-4 w-4 accent-[var(--color-fel)]" disabled={!access || busy === member.userId} checked={checked} onChange={(event) => void setProjectAccess(member, event.target.checked)} />
                </label>
              </li>;
            })}
          </ul>}
        </>}
      </Card>
    </div>
  );
}
