import { useMemo } from "react";
import { useWorkspace, type PeonGroup, type PeonLite } from "../workspace";

export interface PeonPresence {
  peon: PeonLite | null;
  online: boolean;
  known: boolean;
}

export function selectPeon(
  groups: PeonGroup[],
  peonId: string | undefined,
  workspaceId?: string,
): PeonLite | null {
  if (!peonId) return null;
  if (workspaceId) {
    return groups
      .find((group) => group.workspace.id === workspaceId)
      ?.peons.find((peon) => peon.peonId === peonId) ?? null;
  }
  for (const group of groups) {
    const peon = group.peons.find((item) => item.peonId === peonId);
    if (peon) return peon;
  }
  return null;
}

export function selectWorkspacePeons(groups: PeonGroup[], workspaceId: string): PeonLite[] {
  return groups.find((group) => group.workspace.id === workspaceId)?.peons ?? [];
}

/** Reads socket-owned presence for one Peon from the shared workspace projection. */
export function usePeonPresence(peonId: string | undefined, workspaceId?: string): PeonPresence {
  const { groups } = useWorkspace();
  const peon = useMemo(() => selectPeon(groups, peonId, workspaceId), [groups, peonId, workspaceId]);
  return useMemo(() => ({ peon, online: peon?.online ?? false, known: peon !== null }), [peon]);
}

/** Reads the live Peon inventory and presence projection for one workspace. */
export function useWorkspacePeonPresence(workspaceId: string): PeonLite[] {
  const { groups } = useWorkspace();
  return useMemo(() => selectWorkspacePeons(groups, workspaceId), [groups, workspaceId]);
}
