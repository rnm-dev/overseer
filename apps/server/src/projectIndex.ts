import { query, transaction, type Transaction } from "./infrastructure/db/index.js";
import { insertEvent, publishCommittedEvent, type LiveEvent } from "./eventLog.js";
import { toView, type PeonRecord } from "./registry.js";

export interface PeonProject {
  projectId: string;
  key: string;
  name: string | null;
  dir: string | null;
  metadata: string | null;
  quickLinks?: ProjectQuickLink[];
}

export interface ProjectQuickLink {
  id: string;
  title: string;
  url: string;
  order: number;
}

export interface IndexedProject extends PeonProject {
  peonId: string;
  path: string | null;
  sessionCount: number;
  activeCount: number;
  lastActivityMs: number | null;
  syncedAt: number;
}

export interface ProjectCatalogState {
  peonId: string;
  online: boolean;
  state: "legacy" | "syncing" | "ready" | "stale" | "offline";
  stale: boolean;
  updatedAt: number | null;
  catalogRevision: number | null;
}

export interface ProjectSyncCheckpoint {
  catalog: { epoch: string; acknowledgedSeq: number } | null;
  previouslyReady: boolean;
}

interface ProjectMutation {
  event: LiveEvent | null;
}

let lastProjectSyncedAt = 0;
function nextProjectSyncedAt(): number {
  lastProjectSyncedAt = Math.max(Date.now(), lastProjectSyncedAt + 1);
  return lastProjectSyncedAt;
}

async function assertGeneration(tx: Transaction, peonId: string, generation: string): Promise<void> {
  const [delivery, project] = await Promise.all([
    tx.query(`SELECT peon_id FROM peon_session_sync WHERE peon_id=$1 AND generation=$2`, [peonId, generation]),
    tx.query(`SELECT peon_id FROM peon_project_sync WHERE peon_id=$1 AND generation=$2`, [peonId, generation]),
  ]);
  if (!delivery.rows[0] || !project.rows[0]) throw new Error("project sync connection was replaced");
}

async function storeProject(
  tx: Transaction,
  workspaceId: string,
  peonId: string,
  project: PeonProject,
): Promise<ProjectMutation> {
  const existing = await tx.query<{
    project_key: string; name: string | null; dir: string | null; metadata: string | null; quick_links: unknown;
  }>(
    `SELECT project_key,name,dir,metadata,quick_links FROM projects WHERE peon_id=$1 AND project_id=$2`,
    [peonId, project.projectId],
  );
  const current = existing.rows[0];
  const currentQuickLinks = normalizeProjectQuickLinks(current?.quick_links);
  const nextQuickLinks = normalizeProjectQuickLinks(project.quickLinks);
  if (current
    && current.project_key === project.key
    && current.name === project.name
    && current.dir === project.dir
    && current.metadata === project.metadata
    && JSON.stringify(currentQuickLinks) === JSON.stringify(nextQuickLinks)) {
    return { event: null };
  }
  const syncedAt = nextProjectSyncedAt();
  await tx.query(
    `INSERT INTO projects (peon_id,project_id,project_key,name,dir,metadata,quick_links,synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (peon_id,project_id) DO UPDATE SET
       project_key=EXCLUDED.project_key,name=EXCLUDED.name,dir=EXCLUDED.dir,
       metadata=EXCLUDED.metadata,quick_links=EXCLUDED.quick_links,synced_at=EXCLUDED.synced_at`,
    [peonId, project.projectId, project.key, project.name, project.dir, project.metadata, JSON.stringify(nextQuickLinks), syncedAt],
  );
  const payload = {
    peonId,
    projectId: project.projectId,
    key: project.key,
    name: project.name,
    dir: project.dir,
    path: project.dir,
    metadata: project.metadata,
    quickLinks: nextQuickLinks,
    syncedAt,
  };
  return { event: await insertEvent(tx, { workspaceId, peonId, kind: "project", payload }) };
}

async function backfillProjectAccess(
  tx: Transaction,
  workspaceId: string,
  peonId: string,
  projects: PeonProject[],
): Promise<void> {
  const exact = new Map<string, Set<string>>();
  const folded = new Map<string, Set<string>>();
  for (const project of projects) {
    for (const [map, key] of [[exact, project.key], [folded, project.key.toLocaleLowerCase("en-US")]] as const) {
      const ids = map.get(key) ?? new Set<string>();
      ids.add(project.projectId);
      map.set(key, ids);
    }
  }
  const { rows } = await tx.query<{ project_key: string }>(
    `SELECT DISTINCT project_key FROM workspace_member_project_access
     WHERE workspace_id=$1 AND peon_id=$2 AND project_id IS NULL`,
    [workspaceId, peonId],
  );
  for (const row of rows) {
    const exactIds = exact.get(row.project_key);
    const foldedIds = folded.get(row.project_key.toLocaleLowerCase("en-US"));
    const candidates = exactIds?.size === 1 ? exactIds : foldedIds?.size === 1 ? foldedIds : null;
    if (!candidates) continue;
    await tx.query(
      `UPDATE workspace_member_project_access SET project_id=$4
       WHERE workspace_id=$1 AND peon_id=$2 AND project_key=$3 AND project_id IS NULL`,
      [workspaceId, peonId, row.project_key, [...candidates][0]],
    );
  }
}

async function deleteProject(
  tx: Transaction,
  workspaceId: string,
  peonId: string,
  projectId: string,
): Promise<ProjectMutation> {
  const deleted = await tx.query(`DELETE FROM projects WHERE peon_id=$1 AND project_id=$2 RETURNING project_id`, [peonId, projectId]);
  if (!deleted.rows[0]) return { event: null };
  const syncedAt = nextProjectSyncedAt();
  return {
    event: await insertEvent(tx, {
      workspaceId,
      peonId,
      kind: "project",
      payload: { peonId, projectId, deleted: true, syncedAt },
    }),
  };
}

async function publishMutations(mutations: ProjectMutation[]): Promise<void> {
  for (const mutation of mutations) {
    if (!mutation.event) continue;
    await publishCommittedEvent(mutation.event).catch((error) => {
      console.warn("project sync event fan-out failed:", error instanceof Error ? error.message : String(error));
    });
  }
}

export async function claimProjectSyncGeneration(peonId: string, generation: string): Promise<ProjectSyncCheckpoint> {
  const { rows } = await query<{
    catalog_epoch: string | null;
    acknowledged_seq: number | string | null;
    previous_status: string | null;
  }>(
    `INSERT INTO peon_project_sync (peon_id,catalog_epoch,acknowledged_seq,status,updated_at,generation)
     VALUES ($1,NULL,NULL,'syncing',$2,$3)
     ON CONFLICT (peon_id) DO UPDATE SET
       status=CASE WHEN peon_project_sync.catalog_epoch IS NULL THEN 'syncing' ELSE 'ready' END,
       updated_at=EXCLUDED.updated_at,generation=EXCLUDED.generation
     RETURNING catalog_epoch,acknowledged_seq,
       CASE WHEN catalog_epoch IS NOT NULL THEN 'ready' ELSE NULL END AS previous_status`,
    [peonId, Date.now(), generation],
  );
  const row = rows[0];
  return {
    catalog: row?.catalog_epoch && row.acknowledged_seq !== null
      ? { epoch: row.catalog_epoch, acknowledgedSeq: Number(row.acknowledged_seq) }
      : null,
    previouslyReady: row?.previous_status === "ready",
  };
}

export async function markProjectSyncing(peonId: string, generation: string): Promise<void> {
  const { rows } = await query(
    `UPDATE peon_project_sync SET status='syncing',updated_at=$3
     WHERE peon_id=$1 AND generation=$2 RETURNING peon_id`,
    [peonId, generation, Date.now()],
  );
  if (!rows[0]) throw new Error("project sync connection was replaced");
}

export async function releaseProjectSyncGeneration(peonId: string, generation: string): Promise<void> {
  await query(
    `UPDATE peon_project_sync SET status=CASE WHEN catalog_epoch IS NULL THEN 'legacy' ELSE 'stale' END,updated_at=$3
     WHERE peon_id=$1 AND generation=$2`,
    [peonId, generation, Date.now()],
  );
}

async function advanceProjectCheckpoint(
  tx: Transaction,
  peonId: string,
  generation: string,
  catalogEpoch: string,
  acknowledgedSeq: number,
): Promise<void> {
  const { rows } = await tx.query(
    `UPDATE peon_project_sync SET catalog_epoch=$3,acknowledged_seq=$4,status='ready',updated_at=$5
     WHERE peon_id=$1 AND generation=$2 RETURNING peon_id`,
    [peonId, generation, catalogEpoch, acknowledgedSeq, Date.now()],
  );
  if (!rows[0]) throw new Error("project sync connection was replaced");
}

async function advanceDelivery(
  tx: Transaction,
  peonId: string,
  generation: string,
  epoch: string,
  cursor: string,
): Promise<void> {
  const { rows } = await tx.query(
    `UPDATE peon_session_sync SET delivery_epoch=$3,acknowledged_cursor=$4,updated_at=$5
     WHERE peon_id=$1 AND generation=$2 RETURNING peon_id`,
    [peonId, generation, epoch, cursor, Date.now()],
  );
  if (!rows[0]) throw new Error("project sync connection was replaced");
}

export async function applySocketProjectSnapshot(input: {
  workspaceId: string;
  peonId: string;
  generation: string;
  catalogEpoch: string;
  barrierSeq: number;
  projects: PeonProject[];
}): Promise<void> {
  const mutations = await transaction(async (tx) => {
    await assertGeneration(tx, input.peonId, input.generation);
    const existing = await tx.query<{ project_id: string }>(`SELECT project_id FROM projects WHERE peon_id=$1`, [input.peonId]);
    const committed: ProjectMutation[] = [];
    for (const project of input.projects) committed.push(await storeProject(tx, input.workspaceId, input.peonId, project));
    const remoteIds = new Set(input.projects.map((project) => project.projectId));
    for (const row of existing.rows) {
      if (!remoteIds.has(row.project_id)) committed.push(await deleteProject(tx, input.workspaceId, input.peonId, row.project_id));
    }
    // Once the Peon provides immutable IDs, migrate unambiguous legacy key
    // grants in the same transaction as the projection. Canonical reads can
    // then authorize exclusively by ID without a key-reuse window.
    await backfillProjectAccess(tx, input.workspaceId, input.peonId, input.projects);
    await advanceProjectCheckpoint(tx, input.peonId, input.generation, input.catalogEpoch, input.barrierSeq);
    return committed;
  });
  await publishMutations(mutations);
}

async function committedCheckpoints(tx: Transaction, peonId: string, generation: string) {
  const { rows } = await tx.query<{
    catalog_epoch: string | null;
    acknowledged_seq: number | string | null;
    delivery_epoch: string | null;
    acknowledged_cursor: string | null;
  }>(
    `SELECT p.catalog_epoch,p.acknowledged_seq,s.delivery_epoch,s.acknowledged_cursor
       FROM peon_project_sync p JOIN peon_session_sync s ON s.peon_id=p.peon_id
      WHERE p.peon_id=$1 AND p.generation=$2 AND s.generation=$2`,
    [peonId, generation],
  );
  const row = rows[0];
  if (!row?.catalog_epoch || row.acknowledged_seq === null || !row.delivery_epoch || !row.acknowledged_cursor) {
    throw new Error("project durable message has no committed checkpoint");
  }
  return {
    catalog: { epoch: row.catalog_epoch, acknowledgedSeq: Number(row.acknowledged_seq) },
    delivery: { epoch: row.delivery_epoch, acknowledgedCursor: row.acknowledged_cursor },
  };
}

async function insertInbox(tx: Transaction, input: {
  peonId: string;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
}): Promise<boolean> {
  const { rows } = await tx.query(
    `INSERT INTO peon_session_inbox (peon_id,epoch,cursor,created_at,message_id)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING cursor`,
    [input.peonId, input.deliveryEpoch, input.deliveryCursor, Date.now(), input.messageId],
  );
  if (rows[0]) return true;
  const replay = await tx.query<{ epoch: string; cursor: string; message_id: string | null }>(
    `SELECT epoch,cursor,message_id FROM peon_session_inbox
     WHERE peon_id=$1 AND ((epoch=$2 AND cursor=$3) OR message_id=$4)`,
    [input.peonId, input.deliveryEpoch, input.deliveryCursor, input.messageId],
  );
  const row = replay.rows[0];
  if (!row || row.epoch !== input.deliveryEpoch || row.cursor !== input.deliveryCursor || row.message_id !== input.messageId) {
    throw new Error("durable message replay identity mismatch");
  }
  return false;
}

export async function applySocketProjectEvent(input: {
  workspaceId: string;
  peonId: string;
  generation: string;
  catalogEpoch: string;
  seq: number;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
  operation: "upsert" | "delete";
  project?: PeonProject;
  projectId?: string;
}) {
  const result = await transaction(async (tx) => {
    await assertGeneration(tx, input.peonId, input.generation);
    if (!(await insertInbox(tx, input))) return { checkpoint: await committedCheckpoints(tx, input.peonId, input.generation), mutation: null };
    const current = await tx.query<{ catalog_epoch: string | null; acknowledged_seq: number | string | null }>(
      `SELECT catalog_epoch,acknowledged_seq FROM peon_project_sync WHERE peon_id=$1 AND generation=$2`,
      [input.peonId, input.generation],
    );
    const catalog = current.rows[0];
    if (!catalog?.catalog_epoch || catalog.acknowledged_seq === null) throw new Error("project catalog event arrived before snapshot");
    if (catalog.catalog_epoch !== input.catalogEpoch) throw new Error("project catalog epoch mismatch");
    if (input.seq !== Number(catalog.acknowledged_seq) + 1) throw new Error("project catalog sequence gap");
    const mutation = input.operation === "upsert"
      ? await storeProject(tx, input.workspaceId, input.peonId, input.project!)
      : await deleteProject(tx, input.workspaceId, input.peonId, input.projectId!);
    await advanceProjectCheckpoint(tx, input.peonId, input.generation, input.catalogEpoch, input.seq);
    await advanceDelivery(tx, input.peonId, input.generation, input.deliveryEpoch, input.deliveryCursor);
    return {
      checkpoint: {
        catalog: { epoch: input.catalogEpoch, acknowledgedSeq: input.seq },
        delivery: { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor },
      },
      mutation,
    };
  });
  if (result.mutation) await publishMutations([result.mutation]);
  return result.checkpoint;
}

export async function commitSnapshotCoveredProjectEvent(input: {
  peonId: string;
  generation: string;
  catalogEpoch: string;
  seq: number;
  deliveryEpoch: string;
  deliveryCursor: string;
  messageId: string;
}) {
  return transaction(async (tx) => {
    await assertGeneration(tx, input.peonId, input.generation);
    const inserted = await insertInbox(tx, input);
    const checkpoint = await committedCheckpoints(tx, input.peonId, input.generation).catch(async () => {
      const current = await tx.query<{ catalog_epoch: string | null; acknowledged_seq: number | string | null }>(
        `SELECT catalog_epoch,acknowledged_seq FROM peon_project_sync WHERE peon_id=$1 AND generation=$2`,
        [input.peonId, input.generation],
      );
      const row = current.rows[0];
      if (!row?.catalog_epoch || row.acknowledged_seq === null) throw new Error("covered project event has no snapshot checkpoint");
      return {
        catalog: { epoch: row.catalog_epoch, acknowledgedSeq: Number(row.acknowledged_seq) },
        delivery: { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor },
      };
    });
    // Catalog rollover does not necessarily reset the shared durable outbox.
    // A snapshot for the advertised epoch supersedes queued events from the
    // retired epoch; advance only delivery so the global stream can recover.
    if (checkpoint.catalog.epoch === input.catalogEpoch && input.seq > checkpoint.catalog.acknowledgedSeq) {
      throw new Error("project event is not covered by the committed snapshot");
    }
    if (inserted) await advanceDelivery(tx, input.peonId, input.generation, input.deliveryEpoch, input.deliveryCursor);
    return {
      catalog: checkpoint.catalog,
      delivery: inserted ? { epoch: input.deliveryEpoch, acknowledgedCursor: input.deliveryCursor } : checkpoint.delivery,
    };
  });
}

export async function listIndexedProjects(peonId: string): Promise<IndexedProject[]> {
  const { rows } = await query<{
    project_id: string; project_key: string; name: string | null; dir: string | null; metadata: string | null; quick_links: unknown;
    synced_at: number | string; session_count: number | string; active_count: number | string; last_activity_ms: number | string | null;
  }>(
    `SELECT p.project_id,p.project_key,p.name,p.dir,p.metadata,p.quick_links,p.synced_at,
       COUNT(s.session_id) AS session_count,
       SUM(CASE WHEN s.status='running' THEN 1 ELSE 0 END) AS active_count,
       MAX(s.last_activity_at) AS last_activity_ms
     FROM projects p LEFT JOIN sessions s ON s.peon_id=p.peon_id AND s.project_id=p.project_id
     WHERE p.peon_id=$1
     GROUP BY p.project_id,p.project_key,p.name,p.dir,p.metadata,p.quick_links,p.synced_at
     ORDER BY MAX(s.last_activity_at) DESC NULLS LAST,p.project_key`,
    [peonId],
  );
  return rows.map((row) => ({
    peonId,
    projectId: row.project_id,
    key: row.project_key,
    name: row.name,
    dir: row.dir,
    path: row.dir,
    metadata: row.metadata,
    quickLinks: normalizeProjectQuickLinks(row.quick_links),
    syncedAt: Number(row.synced_at),
    sessionCount: Number(row.session_count),
    activeCount: Number(row.active_count),
    lastActivityMs: row.last_activity_ms === null ? null : Number(row.last_activity_ms),
  }));
}

export function normalizeProjectQuickLinks(value: unknown): ProjectQuickLink[] {
  let input = value;
  if (typeof input === "string") {
    try { input = JSON.parse(input); } catch { throw new Error("invalid project quick links"); }
  }
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input) || input.length > 100) throw new Error("invalid project quick links");
  const seenIds = new Set<string>();
  return input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("invalid project quick link");
    const link = item as Record<string, unknown>;
    if (Object.keys(link).some((field) => !["id", "title", "url", "order"].includes(field))) throw new Error("invalid project quick link");
    if (typeof link.id !== "string" || !link.id || link.id.length > 128 || seenIds.has(link.id)) throw new Error("invalid project quick link id");
    if (typeof link.title !== "string"
      || !link.title
      || link.title.length > 120
      || [...link.title].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)) {
      throw new Error("invalid project quick link title");
    }
    if (typeof link.url !== "string" || !link.url || link.url.length > 2_048) throw new Error("invalid project quick link URL");
    let parsed: URL;
    try { parsed = new URL(link.url); } catch { throw new Error("invalid project quick link URL"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("invalid project quick link URL");
    if (!Number.isSafeInteger(link.order) || Number(link.order) < 0) throw new Error("invalid project quick link order");
    seenIds.add(link.id);
    return { id: link.id, title: link.title, url: parsed.href, order: Number(link.order) };
  }).sort((left, right) => left.order - right.order);
}

export async function refreshIndexedProjectQuickLinks(input: {
  workspaceId: string;
  peonId: string;
  key: string;
  quickLinks: unknown;
}): Promise<boolean> {
  const links = normalizeProjectQuickLinks(input.quickLinks);
  const mutation = await transaction(async (tx) => {
    const { rows } = await tx.query<{
      project_id: string; project_key: string; name: string | null; dir: string | null; metadata: string | null;
    }>(
      `SELECT project_id,project_key,name,dir,metadata FROM projects WHERE peon_id=$1 AND project_key=$2`,
      [input.peonId, input.key],
    );
    const project = rows[0];
    if (!project) return null;
    return storeProject(tx, input.workspaceId, input.peonId, {
      projectId: project.project_id,
      key: project.project_key,
      name: project.name,
      dir: project.dir,
      metadata: project.metadata,
      quickLinks: links,
    });
  });
  if (!mutation) return false;
  await publishMutations([mutation]);
  return true;
}

// Evict a project the owner has just deleted on the Peon. The Peon's catalog
// event says the same thing a moment later over the socket, but a client that
// reloads its list first would otherwise be shown a project that no longer
// exists; deleteProject is a row delete, so the later event is a harmless
// no-op. Access grants go with it — nothing should inherit them if the key is
// reused by a new project.
export async function forgetIndexedProject(input: {
  workspaceId: string;
  peonId: string;
  key: string;
  projectId?: string | null;
}): Promise<void> {
  const mutation = await transaction(async (tx) => {
    let projectId = input.projectId ?? null;
    if (!projectId) {
      const { rows } = await tx.query<{ project_id: string }>(
        `SELECT project_id FROM projects WHERE peon_id=$1 AND project_key=$2`,
        [input.peonId, input.key],
      );
      projectId = rows[0]?.project_id ?? null;
    }
    await tx.query(
      `DELETE FROM workspace_member_project_access
       WHERE workspace_id=$1 AND peon_id=$2 AND (project_id=$3 OR (project_id IS NULL AND project_key=$4))`,
      [input.workspaceId, input.peonId, projectId, input.key],
    );
    if (!projectId) return null;
    return deleteProject(tx, input.workspaceId, input.peonId, projectId);
  });
  if (mutation) await publishMutations([mutation]);
}

export async function getIndexedProject(peonId: string, key: string): Promise<IndexedProject | null> {
  return (await listIndexedProjects(peonId)).find((project) => project.key === key) ?? null;
}

export async function getIndexedProjectById(peonId: string, projectId: string): Promise<IndexedProject | null> {
  return (await listIndexedProjects(peonId)).find((project) => project.projectId === projectId) ?? null;
}

export async function hasCanonicalProjectCatalog(peonId: string): Promise<boolean> {
  const { rows } = await query(`SELECT 1 FROM peon_project_sync WHERE peon_id=$1 AND catalog_epoch IS NOT NULL`, [peonId]);
  return rows.length > 0;
}

export async function getProjectCatalogState(record: PeonRecord): Promise<ProjectCatalogState> {
  const { rows } = await query<{ status: string; updated_at: number | string; catalog_epoch: string | null; acknowledged_seq: number | string | null }>(
    `SELECT status,updated_at,catalog_epoch,acknowledged_seq FROM peon_project_sync WHERE peon_id=$1`,
    [record.peonId],
  );
  const row = rows[0];
  const online = toView(record).online;
  const active = row?.catalog_epoch
    ? row.status === "ready" ? "ready" as const : row.status === "syncing" ? "syncing" as const : "stale" as const
    : row?.status === "syncing" ? "syncing" as const : "legacy" as const;
  return {
    peonId: record.peonId,
    online,
    state: online ? active : "offline",
    stale: !online || active === "syncing" || active === "stale",
    updatedAt: row ? Number(row.updated_at) : null,
    catalogRevision: row?.catalog_epoch && row.acknowledged_seq !== null ? Number(row.acknowledged_seq) : null,
  };
}
