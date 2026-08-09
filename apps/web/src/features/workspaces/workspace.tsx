import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, json } from "../../shared/api";
import { applyPeonProjection, mergePeonInventory, type PeonProjection } from "./workspacePeons";

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "member";
  createdAt: number;
}

export interface PeonLite {
  peonId: string;
  name: string | null;
  online: boolean;
  controlConnected?: boolean;
  controlConnectedAt?: number | null;
}

export interface PeonGroup {
  workspace: Workspace;
  peons: PeonLite[];
}

interface WorkspaceState {
  workspaces: Workspace[];
  current: Workspace | null;
  ready: boolean;
  groups: PeonGroup[];
  peonInventoryReady: boolean;
  workspaceIdOfPeon: (peonId: string) => string | undefined;
  updatePeon: (workspaceId: string, peon: PeonProjection) => void;
  setCurrent: (id: string) => void;
  create: (name: string) => Promise<Workspace>;
  refresh: () => Promise<void>;
}

const CURRENT_KEY = "overseer_ws";
const Ctx = createContext<WorkspaceState | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(() => localStorage.getItem(CURRENT_KEY));
  const [ready, setReady] = useState(false);
  const [peonsByWs, setPeonsByWs] = useState<Record<string, PeonLite[]>>({});
  const [hydratedPeonWsIds, setHydratedPeonWsIds] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const r = await api<{ workspaces: Workspace[] }>("/workspaces");
    setWorkspaces(r.workspaces);
    setCurrentId((prev) => (prev && r.workspaces.some((w) => w.id === prev) ? prev : (r.workspaces[0]?.id ?? null)));
    setReady(true);
  }, []);

  useEffect(() => {
    refresh().catch(() => setReady(true));
  }, [refresh]);

  // Hydrate Peon inventory once. The resumable workspace sockets own subsequent
  // projection changes, including connectivity, without a parallel HTTP poll.
  const wsIds = workspaces.map((w) => w.id).join(",");
  useEffect(() => {
    if (!wsIds) return;
    const ids = wsIds.split(",");
    let alive = true;
    const pull = async () => {
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            const r = await api<{ peons: PeonLite[] }>(`/workspaces/${id}/peons`);
            return [id, r.peons ?? []] as const;
          } catch {
            return [id, [] as PeonLite[]] as const;
          }
        }),
      );
      if (alive) {
        setPeonsByWs((current) => Object.fromEntries(entries.map(([workspaceId, peons]) => {
          return [workspaceId, mergePeonInventory(current[workspaceId] ?? [], peons)];
        })));
        setHydratedPeonWsIds(wsIds);
      }
    };
    pull();
    return () => {
      alive = false;
    };
  }, [wsIds]);

  const setCurrent = useCallback((id: string) => {
    localStorage.setItem(CURRENT_KEY, id);
    setCurrentId(id);
  }, []);

  const updatePeon = useCallback((workspaceId: string, peon: PeonProjection) => {
    setPeonsByWs((current) => applyPeonProjection(current, workspaceId, peon));
  }, []);

  const create = useCallback(
    async (name: string) => {
      const r = await api<{ workspace: Workspace }>("/workspaces", json({ name }));
      await refresh();
      setCurrent(r.workspace.id);
      return r.workspace;
    },
    [refresh, setCurrent],
  );

  const current = workspaces.find((w) => w.id === currentId) ?? null;

  const groups = useMemo<PeonGroup[]>(() => workspaces.map((w) => ({ workspace: w, peons: peonsByWs[w.id] ?? [] })), [workspaces, peonsByWs]);
  const peonInventoryReady = !wsIds || hydratedPeonWsIds === wsIds;
  const workspaceIdOfPeon = useCallback((peonId: string) => Object.keys(peonsByWs).find((id) => peonsByWs[id].some((p) => p.peonId === peonId)), [peonsByWs]);

  return <Ctx.Provider value={{ workspaces, current, ready, groups, peonInventoryReady, workspaceIdOfPeon, updatePeon, setCurrent, create, refresh }}>{children}</Ctx.Provider>;
}

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useWorkspace outside WorkspaceProvider");
  return ctx;
}
