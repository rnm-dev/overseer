import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Badge, Button, StatusDot } from "../ui";
import { useT } from "../i18n";
import type { PeonLite, Workspace } from "../workspace";
import { AddPeonDialog } from "./AddPeonDialog";
import { SessionPresence } from "./SessionPresence";
import { useLiveSocket, type PresenceUser } from "../liveSocket";
import { useWorkspace } from "../workspace";
import { useWorkspaceLivePresence } from "../workspaceLive";

// author: Viktor
// One workspace on the fleet dashboard: its peons in a grid and links to its
// dedicated administration surface.

interface StatusPeon {
  peonId: string;
  name: string | null;
  online?: boolean;
  status?: { activeSessionCount?: number } | null;
  lastError?: string | null;
}
export function WorkspaceSection({ workspace, peons }: { workspace: Workspace; peons: PeonLite[] }) {
  const t = useT();
  const { viewersForPeon } = useLiveSocket();
  const { current } = useWorkspace();
  const wsId = workspace.id;
  const isOwner = workspace.role === "owner";

  const [status, setStatus] = useState<Record<string, StatusPeon>>({});
  const [showAddPeon, setShowAddPeon] = useState(false);
  const remotePresence = useWorkspaceLivePresence(wsId, current?.id !== wsId);

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

  const peonViewers = (peonId: string) => current?.id === wsId
    ? viewersForPeon(peonId)
    : uniquePresenceUsers(remotePresence.filter((entry) => entry.peonId === peonId));

  return (
    <section className="mb-9">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="flex items-center gap-2.5 font-display text-sm font-bold uppercase tracking-[0.14em] text-bone">
          <span>{workspace.name}</span>
          {peons.length > 0 && (
            <span className="font-mono text-[0.7rem] font-normal tracking-normal tabular-nums text-bone-faint">
              {onlineCount}/{peons.length}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {isOwner && (
            <Link className="btn-ghost" to={`/workspaces/${wsId}/members`}>
              {t("dashboard.wsAdmin")}
            </Link>
          )}
          {isOwner && <Button size="sm" onClick={() => setShowAddPeon(true)}>
            {t("peons.connect")}
          </Button>}
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
                <div className="warplate flex h-full flex-col transition-colors hover:border-fel/40 hover:bg-fel/[0.03]">
                  <Link to={`/peons/${p.peonId}`} className="flex flex-1 flex-col justify-between gap-3 px-4 py-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <StatusDot state={online ? "on" : "off"} />
                      <div className="flex items-center gap-2">
                        <SessionPresence viewers={peonViewers(p.peonId)} />
                        <Badge tone={online ? "green" : "red"}>{online ? t("peons.online") : t("peons.offline")}</Badge>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate font-display text-sm font-semibold tracking-wide text-bone">{p.name || t("peons.unnamed")}</div>
                      {online ? (
                        <div className={`mt-0.5 flex items-center gap-1.5 font-mono text-xs tabular-nums ${active > 0 ? "text-forge" : "text-bone-faint"}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${active > 0 ? "bg-forge shadow-[0_0_7px_var(--color-forge)]" : "bg-iron-700"}`} />
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
