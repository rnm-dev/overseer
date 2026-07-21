import type { PeonLite } from "./workspace";

export interface PeonProjection {
  peonId: string;
  name?: string | null;
  online: boolean;
}

export function parsePeonProjection(value: unknown): PeonProjection | null {
  const projection = value as { peonId?: unknown; name?: unknown; online?: unknown } | null;
  if (!projection || typeof projection.peonId !== "string" || typeof projection.online !== "boolean") return null;
  return {
    peonId: projection.peonId,
    online: projection.online,
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
  const index = peons.findIndex((peon) => peon.peonId === projection.peonId);
  const next: PeonLite = index >= 0
    ? { ...peons[index], ...(projection.name !== undefined ? { name: projection.name } : {}), online: projection.online }
    : { peonId: projection.peonId, name: projection.name ?? null, online: projection.online };
  const updated = index >= 0
    ? peons.map((peon, itemIndex) => itemIndex === index ? next : peon)
    : [...peons, next];
  return { ...current, [workspaceId]: updated };
}

// HTTP refreshes names/inventory, never connection presence.
export function mergePeonInventory(current: PeonLite[], inventory: PeonLite[]): PeonLite[] {
  const online = new Map(current.map((peon) => [peon.peonId, peon.online]));
  return inventory.map((peon) => ({ ...peon, online: online.get(peon.peonId) ?? false }));
}
