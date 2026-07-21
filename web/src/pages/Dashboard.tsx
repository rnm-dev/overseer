import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { api } from "../api";
import { useWorkspace, type Workspace } from "../workspace";
import { useWorkspacePeonPresence } from "../hooks/usePeonPresence";
import { Logo, StatusDot } from "../ui";
import { useT } from "../i18n";
import { useAuth, type User } from "../auth";
import { SessionPresence } from "../components/SessionPresence";
import { useLiveSocket, type PresenceEntry, type PresenceUser } from "../liveSocket";
import { useWorkspaceLivePresence } from "../workspaceLive";

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

export function workspaceListClass(count: number): string {
  return count === 1 ? "mx-auto max-w-2xl" : "grid gap-4 sm:grid-cols-2";
}

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

  return (
    <div className="mx-auto w-full max-w-6xl flex-1 px-6 pb-8 pt-7">
      <header className="mb-10 flex flex-col items-center">
        <Link to="/" className="flex min-w-0 flex-col items-center text-center">
          <Logo size={144} />
          <span className="dashboard-identity" title={username}>
            {username}
          </span>
        </Link>
      </header>

      {!ready ? (
        <div className="grid min-h-44 place-items-center" aria-label={t("workspace.loading")}><div className="forge-spin" /></div>
      ) : groups.length === 0 ? (
        <div className="warplate px-6 py-12 text-center">
          <p className="font-display text-base font-semibold text-bone">{t("workspace.empty")}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-bone-faint">{t("workspace.emptyJoinedHint")}</p>
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
    const timer = window.setInterval(pull, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [workspace.id]);

  return (
    <article className="warplate overflow-hidden">
      <Link
        to={workspaceHref(workspace.id)}
        className="group block px-5 py-6 transition-colors hover:bg-fel/[0.035] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fel/60"
      >
        <h2 className="truncate font-display text-xl font-bold tracking-wide text-fel-bright transition-colors group-hover:text-fel">
          {workspace.name}
        </h2>
      </Link>

      {peons.length > 0 && (
        <ul className="divide-y divide-iron-800 border-t border-iron-800">
          {peons.map((peon) => {
            const current = status[peon.peonId];
            const online = peon.online;
            const activeSessions = current?.status?.activeSessionCount ?? 0;
            const viewers = peonViewers(peon.peonId);
            return <li key={peon.peonId}>
              <Link
                to={peonHref(peon.peonId)}
                className="group/peon flex items-center gap-3 px-4 py-3 transition-colors hover:bg-iron-800/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fel/60"
              >
                <StatusDot state={online ? "on" : "off"} />
                <span className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-bone group-hover/peon:text-fel-bright">
                  {peon.name || t("peons.unnamed")}
                </span>
                <span className={`font-mono text-xs tabular-nums ${online && activeSessions > 0 ? "text-forge" : "text-bone-faint"}`}>
                  {online ? t("peons.active", { n: activeSessions }) : t("peons.offline")}
                </span>
                <SessionPresence viewers={viewers} size="xs" />
                <ChevronRight size={15} className="text-bone-faint" aria-hidden="true" />
              </Link>
            </li>;
          })}
        </ul>
      )}
    </article>
  );
}
