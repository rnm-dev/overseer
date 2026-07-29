import { useEffect, useState } from "react";
import { Link } from "react-router";
import { MessageSquare, Server, Users } from "lucide-react";
import { api } from "../api";
import { Badge, Button } from "../ui";
import { PeonConnectionStatusDot } from "./PeonConnectionStatusDot";
import { useT } from "../i18n";
import type { Workspace } from "../workspace";
import { AddPeonDialog } from "./AddPeonDialog";
import { SessionPresence } from "./SessionPresence";
import { useLiveSocket, type PresenceUser } from "../liveSocket";
import { useWorkspace } from "../workspace";
import { useWorkspaceLivePresence } from "../workspaceLive";
import { useWorkspacePeonPresence } from "../hooks/usePeonPresence";

// author: Viktor
// One workspace on the fleet dashboard: its peons in a grid and links to its
// dedicated administration surface.

interface StatusPeon {
  peonId: string;
  name: string | null;
  status?: { activeSessionCount?: number } | null;
  lastError?: string | null;
}
export function WorkspaceSection({ workspace }: { workspace: Workspace }) {
  const t = useT();
  const { viewersForPeon } = useLiveSocket();
  const { current } = useWorkspace();
  const wsId = workspace.id;
  const isOwner = workspace.role === "owner";
  const peons = useWorkspacePeonPresence(wsId);

  const [status, setStatus] = useState<Record<string, StatusPeon>>({});
  const [showAddPeon, setShowAddPeon] = useState(false);
  const remotePresence = useWorkspaceLivePresence(wsId, current?.id !== wsId);

  const onlineCount = peons.filter((p) => p.online).length;

  // HTTP supplies active-session counts and last errors only. Connectivity is
  // read from the socket-owned workspace projection above.
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

  const peonViewers = (peonId: string) => current?.id === wsId
    ? viewersForPeon(peonId)
    : uniquePresenceUsers(remotePresence.filter((entry) => entry.peonId === peonId));

  return (
    <section className="surface mb-5 overflow-hidden" aria-labelledby={`workspace-${wsId}`}>
      <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-3 border-b border-iron-800 bg-iron-950/35 px-5 py-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`workspace-${wsId}`} className="truncate font-display text-base font-semibold tracking-wide text-bone">
              {workspace.name}
            </h2>
            <Badge tone={isOwner ? "green" : "neutral"}>{t(isOwner ? "workspace.owner" : "workspace.member")}</Badge>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-bone-faint">
            <span className="font-mono">/{workspace.slug}</span>
            <span className="inline-flex items-center gap-1.5">
              <Server size={13} aria-hidden="true" />
              {peons.length === 0
                ? t("workspace.noPeons")
                : t("workspace.peonStatus", { online: onlineCount, total: peons.length })}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Link className="btn-ghost inline-flex items-center gap-1.5" to={`/workspaces/${wsId}/sessions`}>
            <MessageSquare size={13} aria-hidden="true" />
            {t("peon.tab.sessions")}
          </Link>
          {isOwner && (
            <Link className="btn-ghost inline-flex items-center gap-1.5" to={`/workspaces/${wsId}/members`}>
              <Users size={13} aria-hidden="true" />
              {t("dashboard.wsAdmin")}
            </Link>
          )}
          {isOwner && <Button size="sm" onClick={() => setShowAddPeon(true)}>
            {t("peons.connect")}
          </Button>}
        </div>
      </div>

      {peons.length === 0 ? (
        <div className="px-5 py-9 text-center">
          <p className="text-sm text-bone-dim">{t(isOwner ? "workspace.emptyOwner" : "workspace.emptyMember")}</p>
          {isOwner && (
            <button type="button" className="btn-ghost mt-2" onClick={() => setShowAddPeon(true)}>
              {t("peons.connect")}
            </button>
          )}
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
          {peons.map((p) => {
            const st = status[p.peonId];
            const online = p.online;
            const active = st?.status?.activeSessionCount ?? 0;
            return (
              <li key={p.peonId}>
                <div className="surface surface--subtle surface--interactive flex h-full flex-col">
                  <Link to={`/peons/${p.peonId}`} className="flex flex-1 flex-col justify-between gap-3 px-4 py-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <PeonConnectionStatusDot {...p} />
                      <div className="flex items-center gap-2">
                        <SessionPresence viewers={peonViewers(p.peonId)} />
                        <Badge tone={online ? "green" : "red"}>{online ? t("peons.online") : t("peons.offline")}</Badge>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-display text-sm font-semibold tracking-wide text-bone">{p.name || t("peons.unnamed")}</div>
                      {online ? (
                        <div className={`mt-0.5 flex items-center gap-1.5 font-mono text-xs tabular-nums ${active > 0 ? "text-forge" : "text-bone-faint"}`}>
                          <span className={`h-2 w-2 rounded-full ${active > 0 ? "bg-forge shadow-[0_0_4px_var(--color-forge),0_0_11px_var(--color-forge)]" : "bg-iron-700"}`} />
                          {t("peons.active", { n: active })}
                        </div>
                      ) : st?.lastError ? <div className="mt-0.5 truncate font-mono text-xs text-blood/80">{st.lastError}</div> : null}
                    </div>
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {isOwner && showAddPeon && <AddPeonDialog workspaceId={wsId} onClose={() => setShowAddPeon(false)} onAdded={() => setShowAddPeon(false)} />}
    </section>
  );
}

function uniquePresenceUsers(entries: PresenceUser[]): PresenceUser[] {
  const users = new Map<string, PresenceUser>();
  for (const entry of entries) {
    const key = entry.email.toLowerCase();
    if (!users.has(key)) users.set(key, entry);
  }
  return [...users.values()].sort((a, b) => (a.githubLogin || a.email).localeCompare(b.githubLogin || b.email));
}
