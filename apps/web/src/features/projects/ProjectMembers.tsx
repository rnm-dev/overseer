import { useEffect, useState } from "react";
import { Navigate, useParams } from "react-router";
import { Check, Users } from "lucide-react";
import { api, json } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { Badge, Card } from "../../shared/ui";
import { usePeon } from "../fleet/context";
import { Avatar } from "../../shared/Avatar";
import { ProjectTabs } from "./ProjectTabs";
import { ProjectPageHeader } from "./ProjectPageHeader";

interface Member {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
  role: "owner" | "member";
  access: boolean;
  administrator: boolean;
}

export const PROJECT_MEMBER_LIST_CLASS = "divide-y divide-edge/60";

export function ProjectMembers() {
  const t = useT();
  const { key = "" } = useParams();
  const { peon, wsId } = usePeon();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ members: Member[] }>(`/workspaces/${wsId}/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}/members`)
      .then((result) => alive && setMembers(result.members))
      .catch((err) => {
        if (!alive) return;
        if (err && typeof err === "object" && "status" in err && err.status === 403) setForbidden(true);
        else setError(err instanceof Error ? err.message : t("members.accessLoadFailed"));
      });
    return () => { alive = false; };
  }, [key, peon.peonId, t, wsId]);

  if (forbidden) return <Navigate to={`/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}`} replace />;

  const regularMembers = members?.filter((member) => member.role === "member") ?? [];
  const owners = members?.filter((member) => member.role === "owner") ?? [];

  async function setProjectAccess(member: Member, enabled: boolean) {
    setBusy(member.userId);
    setSaved(null);
    setError(null);
    try {
      await api(`/workspaces/${wsId}/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}/members/${encodeURIComponent(member.userId)}`, { ...json({ access: enabled }), method: "PUT" });
      setMembers((value) => value?.map((item) => item.userId === member.userId ? { ...item, access: enabled || item.administrator } : item) ?? value);
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
      {error && <p className="rounded-md border border-danger/30 bg-danger/5 px-4 py-3 font-mono text-xs text-danger">⚠ {error}</p>}
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3 border-b border-edge px-5 py-4">
          <div className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-accent/10 text-accent-strong"><Users size={17} aria-hidden /></div>
          <div><h2 className="font-display text-sm font-semibold text-ink">{t("proj.members.title")}</h2><p className="mt-1 font-mono text-[0.7rem] text-ink-faint">{t("proj.members.hint")}</p></div>
        </div>
        {members === null ? <div className="grid min-h-40 place-items-center"><div className="loading-spinner" /></div> : <>
          {owners.length > 0 && <div className="border-b border-edge bg-surface/25 px-5 py-3"><p className="font-mono text-[0.68rem] text-ink-faint">{t("proj.members.owners", { n: owners.length })}</p></div>}
          {regularMembers.length === 0 ? <p className="p-8 text-center font-mono text-sm text-ink-faint">{t("proj.members.empty")}</p> : <ul className={PROJECT_MEMBER_LIST_CLASS}>
            {regularMembers.map((member) => {
              const checked = member.access;
              return <li key={member.userId} className="flex items-center justify-between gap-4 px-5 py-4 transition-colors hover:bg-surface-hover/20">
                <div className="flex min-w-0 items-center gap-3">
                  <Avatar src={member.avatarUrl} label={member.githubLogin || member.email} size="lg" className="border-edge-strong" />
                  <div className="min-w-0"><p className="truncate font-display text-sm font-semibold text-ink">{member.githubLogin ? `@${member.githubLogin}` : member.email}</p>{member.githubLogin && <p className="truncate font-mono text-[0.68rem] text-ink-faint">{member.email}</p>}{member.administrator && <p className="font-mono text-[0.68rem] text-accent">{t("proj.members.administrator")}</p>}</div>
                </div>
                <label className="flex cursor-pointer items-center gap-2.5">
                  {saved === member.userId && <Badge tone="green"><Check size={11} aria-hidden />{t("peon.settings.saved")}</Badge>}
                  <span className="font-display text-xs text-ink-muted">{checked ? t("proj.members.canAccess") : t("proj.members.noAccess")}</span>
                  <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" disabled={member.administrator || busy === member.userId} checked={checked} onChange={(event) => void setProjectAccess(member, event.target.checked)} />
                </label>
              </li>;
            })}
          </ul>}
        </>}
      </Card>
    </div>
  );
}
