import type { PeonLite } from "./workspace";
import { mergeResourceProjection } from "../../shared/resourceProjection.js";

export interface PeonProjection {
  peonId: string;
  name?: string | null;
  online: boolean;
  controlConnected?: boolean;
  controlConnectedAt?: number | null;
}

export function parsePeonProjection(value: unknown): PeonProjection | null {
  const projection = value as {
    peonId?: unknown;
    name?: unknown;
    online?: unknown;
    controlConnected?: unknown;
    controlConnectedAt?: unknown;
  } | null;
  if (!projection || typeof projection.peonId !== "string" || typeof projection.online !== "boolean") return null;
  return {
    peonId: projection.peonId,
    online: projection.online,
    ...(typeof projection.controlConnected === "boolean" ? { controlConnected: projection.controlConnected } : {}),
    ...(projection.controlConnectedAt === null || typeof projection.controlConnectedAt === "number" ? { controlConnectedAt: projection.controlConnectedAt } : {}),
    ...(projection.name === null || typeof projection.name === "string" ? { name: projection.name } : {}),
  };
}

export function parsePeonProjections(value: unknown): PeonProjection[] {
  if (!Array.isArray(value)) return [];
  return value.map(parsePeonProjection).filter((projection): projection is PeonProjection => projection !== null);
}

export function applyPeonProjection(
  current: Record<string, PeonLite[]>,
  workspaceId: string,
  projection: PeonProjection,
): Record<string, PeonLite[]> {
  const peons = current[workspaceId] ?? [];
  const incoming = projection as PeonLite;
  const updated = mergeResourceProjection(peons, [incoming],
    (peon) => peon.peonId,
    (peon) => peon.controlConnectedAt,
    (previous, peon) => previous
      ? { ...previous, ...peon }
      : { ...peon, name: peon.name ?? null });
  return { ...current, [workspaceId]: updated };
}

// HTTP refreshes names/inventory, never connection presence.
export function mergePeonInventory(current: PeonLite[], inventory: PeonLite[]): PeonLite[] {
  const presence = new Map(current.map((peon) => [peon.peonId, peon]));
  return inventory.map((peon) => {
    const projected = presence.get(peon.peonId);
    return {
      ...peon,
      online: projected?.online ?? false,
      controlConnected: projected?.controlConnected ?? false,
      controlConnectedAt: projected?.controlConnectedAt ?? null,
    };
  });
}
