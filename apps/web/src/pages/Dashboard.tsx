import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ChevronRight, Plus } from "lucide-react";
import { api } from "../api";
import { useWorkspace, type Workspace } from "../workspace";
import { useWorkspacePeonPresence } from "../hooks/usePeonPresence";
import { Button, OverseerWordmark } from "../ui";
import { PeonConnectionStatusDot } from "../components/PeonConnectionStatusDot";
import { useT } from "../i18n";
import { useAuth, type User } from "../auth";
import { SessionPresence } from "../components/SessionPresence";
import { useLiveSocket, type PresenceEntry, type PresenceUser } from "../liveSocket";
import { useWorkspaceLivePresence } from "../workspaceLive";
import { UserBox } from "../components/UserBox";
import { NewWorkspaceDialog } from "../components/NewWorkspaceDialog";

// author: Viktor
// The fleet dashboard (index): every peon in a grid, grouped by workspace. No
// sidebar — the account panel is the final in-flow page block (AppLayout → UserBox).
export function displayUsername(user: User | null): string {
  return user?.githubLogin || user?.email.split("@")[0] || "";
}

export function workspaceHref(id: string): string {
  return `/workspaces/${encodeURIComponent(id)}`;
}

export function peonHref(id: string): string {
  return `/peons/${encodeURIComponent(id)}`;
}

export function workspaceListClass(_count: number): string {
  return "mx-auto max-w-2xl space-y-4";
}

export function userBoxLayoutClass(workspaceCount: number): string {
  return `mt-4 ${workspaceListClass(workspaceCount)}`;
}

export const HOME_WORKSPACE_CARD_CLASS = "surface overflow-hidden";
export const HOME_WORKSPACE_HEADER_CLASS = "group block px-5 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";
export const HOME_WORKSPACE_TITLE_CLASS = "truncate font-display text-lg font-bold tracking-[0.06em] text-accent-strong drop-shadow-[0_0_8px_rgba(134,171,99,0.18)] transition-colors group-hover:text-accent";
export const HOME_PEON_LIST_CLASS = "space-y-3 px-4 pb-4";
export const HOME_PEON_LINK_CLASS = "on-surface on-surface--interactive group/peon flex items-center gap-3 rounded-lg px-4 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60";
export const HOME_CREATE_WORKSPACE_CLASS = "mt-6 gap-2";

export function presenceUsersForPeon(entries: PresenceEntry[], peonId: string): PresenceUser[] {
  const users = new Map<string, PresenceUser>();
  for (const entry of entries) {
    if (entry.peonId !== peonId) continue;
    const key = entry.email.toLowerCase();
    if (!users.has(key)) users.set(key, entry);
  }
  return [...users.values()].sort((a, b) => (a.githubLogin || a.email).localeCompare(b.githubLogin || b.email));
}

export function Dashboard() {
  const t = useT();
  const { groups, ready } = useWorkspace();
  const { user } = useAuth();
  const username = displayUsername(user);
  const [showNewWorkspace, setShowNewWorkspace] = useState(false);

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-6 pb-8 pt-7">
      <header className="mb-10 flex flex-col items-center">
        <Link to="/" className="flex min-w-0 flex-col items-center text-center">
          <OverseerWordmark size="hero" />
          <span className="dashboard-operator" title={username}>
            {username}
          </span>
        </Link>
        <Button className={HOME_CREATE_WORKSPACE_CLASS} onClick={() => setShowNewWorkspace(true)}>
          <Plus size={16} aria-hidden="true" />
          {t("workspace.create")}
        </Button>
      </header>

      {!ready ? (
        <div className="grid min-h-44 place-items-center" aria-label={t("workspace.loading")}><div className="loading-spinner" /></div>
      ) : (
        <>
          {groups.length === 0 ? (
            <div className="surface px-6 py-12 text-center">
              <p className="font-display text-base font-semibold text-ink">{t("workspace.empty")}</p>
              <p className="mx-auto mt-1 max-w-md text-sm text-ink-faint">{t("workspace.emptyJoinedHint")}</p>
            </div>
          ) : (
            <ul className={workspaceListClass(groups.length)}>
              {groups.map((group) => (
                <li key={group.workspace.id}>
                  <WorkspaceCard workspace={group.workspace} />
                </li>
              ))}
            </ul>
          )}
          <div className={userBoxLayoutClass(groups.length)}>
            <UserBox />
          </div>
        </>
      )}
      {showNewWorkspace && <NewWorkspaceDialog onClose={() => setShowNewWorkspace(false)} />}
    </div>
  );
}

interface HomePeonStatus {
  peonId: string;
  status?: { activeSessionCount?: number } | null;
}

function WorkspaceCard({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const { current } = useWorkspace();
  const { viewersForPeon } = useLiveSocket();
  const [status, setStatus] = useState<Record<string, HomePeonStatus>>({});
  const peons = useWorkspacePeonPresence(workspace.id);
  const remotePresence = useWorkspaceLivePresence(workspace.id, current?.id !== workspace.id);

  const peonViewers = (peonId: string) => current?.id === workspace.id
    ? viewersForPeon(peonId)
    : presenceUsersForPeon(remotePresence, peonId);

  useEffect(() => {
    let active = true;
    const pull = () => api<{ peons: HomePeonStatus[] }>(`/workspaces/${encodeURIComponent(workspace.id)}/status`)
      .then((result) => {
        if (active) setStatus(Object.fromEntries((result.peons ?? []).map((peon) => [peon.peonId, peon])));
      })
      .catch(() => undefined);
    void pull();
    return () => {
      active = false;
    };
  }, [workspace.id]);

  return (
    <article className={HOME_WORKSPACE_CARD_CLASS}>
      <Link
        to={workspaceHref(workspace.id)}
        className={HOME_WORKSPACE_HEADER_CLASS}
      >
        <h2 className={HOME_WORKSPACE_TITLE_CLASS}>
          {workspace.name}
        </h2>
      </Link>

      {peons.length > 0 && (
        <ul className={HOME_PEON_LIST_CLASS}>
          {peons.map((peon) => {
            const current = status[peon.peonId];
            const online = peon.online;
            const activeSessions = current?.status?.activeSessionCount ?? 0;
            const viewers = peonViewers(peon.peonId);
            return <li key={peon.peonId}>
              <Link
                to={peonHref(peon.peonId)}
                className={HOME_PEON_LINK_CLASS}
              >
                <PeonConnectionStatusDot {...peon} />
                <span className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-ink group-hover/peon:text-accent-strong">
                  {peon.name || t("peons.unnamed")}
                </span>
                <span className={`font-mono text-xs tabular-nums ${online && activeSessions > 0 ? "text-warning" : "text-ink-faint"}`}>
                  {online ? t("peons.active", { n: activeSessions }) : t("peons.offline")}
                </span>
                <SessionPresence viewers={viewers} size="xs" />
                <ChevronRight size={15} className="text-ink-faint" aria-hidden="true" />
              </Link>
            </li>;
          })}
        </ul>
      )}
    </article>
  );
}
