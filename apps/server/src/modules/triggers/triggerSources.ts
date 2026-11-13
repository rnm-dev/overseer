import { randomUUID } from "node:crypto";
import { query, withAdvisoryLock } from "../../infrastructure/db/index.js";
import { callPeon, connOfRecord } from "../../infrastructure/peonHttp/index.js";
import { isPeonConnected, type PeonRecord } from "../fleet/index.js";
import { indexAcceptedSession, recordSessionRequest, runIdempotentFollowup } from "../sessions/index.js";
import { resolveAutomationTokenById, type AutomationContext } from "../automation/index.js";

// Trigger sources (docs/triggers.md). A caller posts each event of one source
// (a chat, a ticket thread) as it happens; Overseer buffers them and, once the
// source has been quiet for `quietMs` (never longer than `maxMs` from the
// stint's first event), delivers them as one stint: the first stint creates a
// trigger-origin session, later ones are follow-ups into it. Nothing is
// truncated and the timer lives in the database, so a restart loses nothing.

export const DEFAULT_QUIET_MS = 12 * 60_000;
export const DEFAULT_MAX_MS = 60 * 60_000;
const MAX_WINDOW_MS = 24 * 60 * 60_000;
const RETRY_MS = 30_000;
const WORKER_MS = 2_000;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;

export class TriggerSourceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export interface IncomingEvent {
  externalId: unknown;
  text: unknown;
  author?: unknown;
  at?: unknown;
  quietMs?: unknown;
  maxMs?: unknown;
}

interface SourceRow {
  id: string;
  source_id: string;
  token_id: string;
  peon_id: string;
  project_key: string | null;
  session_id: string | null;
  quiet_ms: string | number;
  max_ms: string | number;
  stint_started_at: string | number | null;
  deadline_at: string | number | null;
  last_request_id: string | null;
  last_fired_at: string | number | null;
  last_error: string | null;
}

interface EventRow {
  id: string;
  external_id: string;
  author: string | null;
  text: string;
  at: string | number;
}

const num = (value: string | number | null): number | null => value === null ? null : Number(value);

function window(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > MAX_WINDOW_MS) {
    throw new TriggerSourceError(400, "BAD_REQUEST", `${name} must be an integer between 0 and ${MAX_WINDOW_MS}`);
  }
  return value;
}

export function validSourceId(value: string): boolean {
  return SOURCE_ID.test(value);
}

const scopeKey = (c: AutomationContext) => `${c.record.peonId}:${c.projectId ?? c.projectKey ?? "*"}`;

export async function ingestEvent(c: AutomationContext, sourceId: string, input: IncomingEvent, now = Date.now()) {
  if (!validSourceId(sourceId)) throw new TriggerSourceError(400, "BAD_REQUEST", "sourceId must be 1–200 characters of letters, digits and ._:@/-");
  if (typeof input.externalId !== "string" || !input.externalId.trim() || input.externalId.length > 255) {
    throw new TriggerSourceError(400, "BAD_REQUEST", "externalId is required (your id for this event, at most 255 characters)");
  }
  if (typeof input.text !== "string" || !input.text.trim()) throw new TriggerSourceError(400, "BAD_REQUEST", "text is required");
  if (input.author !== undefined && input.author !== null && typeof input.author !== "string") {
    throw new TriggerSourceError(400, "BAD_REQUEST", "author must be a string");
  }
  if (input.at !== undefined && (typeof input.at !== "number" || !Number.isFinite(input.at))) {
    throw new TriggerSourceError(400, "BAD_REQUEST", "at must be a millisecond timestamp");
  }
  const quietMs = window(input.quietMs, DEFAULT_QUIET_MS, "quietMs");
  const maxMs = Math.max(quietMs, window(input.maxMs, DEFAULT_MAX_MS, "maxMs"));
  if (!c.projectKey) throw new TriggerSourceError(400, "BAD_REQUEST", "trigger sources need a project-scoped token");

  // The latest event's token and windows win: rotating a key or retuning the
  // stint takes effect on the next event.
  const { rows: sources } = await query<SourceRow>(
    `INSERT INTO trigger_sources (id, scope_key, source_id, token_id, workspace_id, peon_id, project_key,
                                  quiet_ms, max_ms, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
     ON CONFLICT (scope_key, source_id) DO UPDATE
       SET token_id=EXCLUDED.token_id, quiet_ms=EXCLUDED.quiet_ms, max_ms=EXCLUDED.max_ms, updated_at=EXCLUDED.updated_at
     RETURNING *`,
    [randomUUID(), scopeKey(c), sourceId, c.token.id, c.workspaceId, c.record.peonId, c.projectKey, quietMs, maxMs, now],
  );
  const source = sources[0]!;
  const eventId = randomUUID();
  const inserted = await query<{ id: string }>(
    `INSERT INTO trigger_source_events (id, source_row, external_id, author, text, at, received_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (source_row, external_id) DO NOTHING RETURNING id`,
    [eventId, source.id, input.externalId.trim(), typeof input.author === "string" ? input.author.slice(0, 200) : null,
      input.text, typeof input.at === "number" ? Math.trunc(input.at) : now, now],
  );
  if (inserted.rows[0]?.id !== eventId) return { ...(await sourceStatus(c, sourceId)), duplicate: true };

  // Every event pushes the deadline out by quietMs, never past maxMs from the
  // stint's first event.
  await query(
    `UPDATE trigger_sources
        SET stint_started_at = COALESCE(stint_started_at, $2),
            deadline_at = LEAST($2 + quiet_ms, COALESCE(stint_started_at, $2) + max_ms),
            updated_at = $2
      WHERE id = $1`,
    [source.id, now],
  );
  return { ...(await sourceStatus(c, sourceId)), duplicate: false, eventId };
}

export async function sourceStatus(c: AutomationContext, sourceId: string) {
  const { rows } = await query<SourceRow>(
    `SELECT * FROM trigger_sources WHERE scope_key = $1 AND source_id = $2`,
    [scopeKey(c), sourceId],
  );
  const row = rows[0];
  if (!row) throw new TriggerSourceError(404, "UNKNOWN_SOURCE", "no events have been posted for this source");
  const { rows: counted } = await query<{ pending: string | number }>(
    `SELECT COUNT(*) AS pending FROM trigger_source_events WHERE source_row = $1 AND delivered_as IS NULL`,
    [row.id],
  );
  return {
    sourceId: row.source_id,
    state: num(row.deadline_at) === null ? "idle" : "buffering",
    pendingEvents: Number(counted[0]?.pending ?? 0),
    deadlineAt: num(row.deadline_at),
    quietMs: num(row.quiet_ms),
    maxMs: num(row.max_ms),
    sessionId: row.session_id,
    lastRequestId: row.last_request_id,
    lastFiredAt: num(row.last_fired_at),
    lastError: row.last_error,
  };
}

async function pendingEvents(sourceRow: string): Promise<EventRow[]> {
  const { rows } = await query<EventRow>(
    `SELECT id, external_id, author, text, at FROM trigger_source_events
      WHERE source_row = $1 AND delivered_as IS NULL ORDER BY at, received_at, id`,
    [sourceRow],
  );
  return rows;
}

const stamp = (at: number) => new Date(at).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");

export function stintPrompt(sourceId: string, events: readonly { author: string | null; text: string; at: string | number }[]): string {
  const lines = events.map((event) => `[${stamp(Number(event.at))}] ${event.author ?? "unknown"}: ${event.text}`);
  return `New messages from source ${sourceId} (${events.length}):\n\n${lines.join("\n\n")}`;
}

async function markDelivered(ids: readonly string[], stintId: string, as: "stint" | "context"): Promise<void> {
  if (ids.length === 0) return;
  await query(`UPDATE trigger_source_events SET stint_id=$2, delivered_as=$3 WHERE id = ANY($1)`, [ids, stintId, as]);
}

// After delivery, events that arrived meanwhile open the next stint at once.
async function rearm(sourceRow: string, now: number): Promise<void> {
  const { rows } = await query<{ first: string | number | null }>(
    `SELECT MIN(received_at) AS first FROM trigger_source_events WHERE source_row = $1 AND delivered_as IS NULL`,
    [sourceRow],
  );
  const first = num(rows[0]?.first ?? null);
  await query(
    `UPDATE trigger_sources
        SET stint_started_at = $2::bigint,
            deadline_at = CASE WHEN $2::bigint IS NULL THEN NULL ELSE LEAST($3 + quiet_ms, $2::bigint + max_ms) END
      WHERE id = $1`,
    [sourceRow, first, now],
  );
}

async function fail(sourceRow: string, message: string, now: number): Promise<void> {
  await query(`UPDATE trigger_sources SET last_error=$2, deadline_at=$3, updated_at=$4 WHERE id=$1`,
    [sourceRow, message.slice(0, 500), now + RETRY_MS, now]);
}

export async function fireSource(source: SourceRow, now = Date.now()): Promise<void> {
  const events = await pendingEvents(source.id);
  if (events.length === 0) {
    await query(`UPDATE trigger_sources SET deadline_at=NULL, stint_started_at=NULL WHERE id=$1`, [source.id]);
    return;
  }
  const c = await resolveAutomationTokenById(source.token_id);
  if (!("token" in c)) {
    // The key was revoked or its owner lost access: keep the events, stop retrying.
    await query(`UPDATE trigger_sources SET last_error=$2, deadline_at=NULL WHERE id=$1`, [source.id, `${c.code}: ${c.message}`]);
    return;
  }
  if (!isPeonConnected(c.record.peonId)) return fail(source.id, "the Peon is offline; retrying", now);

  const stintId = randomUUID();
  const prompt = stintPrompt(source.source_id, events);
  const conn = connOfRecord(c.record);
  let sessionId = source.session_id;
  if (!sessionId) {
    const result = await callPeon(conn, "POST", "/sessions", {
      actor: c.operator.email,
      requestId: stintId,
      body: {
        prompt,
        projectKey: source.project_key,
        origin: "trigger",
        trigger: { id: c.token.id, source: "automation", correlationId: source.source_id },
      },
    });
    const id = result.ok && result.json && typeof (result.json as { id?: unknown }).id === "string" ? (result.json as { id: string }).id : null;
    if (!id) return fail(source.id, `could not start the session (${result.status})`, now);
    sessionId = id;
    await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
    await recordSessionRequest({ workspaceId: c.workspaceId, userId: c.userId, peonId: c.record.peonId, sessionId, occurrenceKey: `create:${stintId}` }).catch(() => undefined);
  } else {
    const body = { prompt, commandId: stintId };
    const result = await runIdempotentFollowup(c.record.peonId, sessionId, stintId, body, () =>
      callPeon(conn, "POST", `/sessions/${encodeURIComponent(sessionId!)}/followup`, { actor: c.operator.email, body, requestId: stintId }));
    if (result.status === 404) {
      // The session was deleted: the next stint starts a new one.
      await query(`UPDATE trigger_sources SET session_id=NULL WHERE id=$1`, [source.id]);
      return fail(source.id, "the source's session no longer exists; starting a new one", now - RETRY_MS);
    }
    if (!result.ok) return fail(source.id, `could not deliver the stint (${result.status})`, now);
    await indexAcceptedSession(result, c.workspaceId, c.record.peonId);
    await recordSessionRequest({ workspaceId: c.workspaceId, userId: c.userId, peonId: c.record.peonId, sessionId, occurrenceKey: `followup:${stintId}` }).catch(() => undefined);
  }
  await markDelivered(events.map((event) => event.id), stintId, "stint");
  await query(
    `UPDATE trigger_sources SET session_id=$2, last_request_id=$3, last_fired_at=$4, last_error=NULL, updated_at=$4 WHERE id=$1`,
    [source.id, sessionId, stintId, now],
  );
  await rearm(source.id, now);
}

// The pre-execution check: before a person's decision reaches a sign-off's
// session, whatever that session's source received since is put in front of
// the agent as context, so the approving turn sees it (docs/triggers.md).
//
// It goes out as the person deciding, who already has access to the session —
// not with the source's key, which may have expired or been revoked since and
// must not be able to silently skip this check.
export async function flushSourceContext(record: PeonRecord, actor: string, sessionId: string, now = Date.now()): Promise<number> {
  const { rows } = await query<SourceRow>(`SELECT * FROM trigger_sources WHERE peon_id=$1 AND session_id=$2`, [record.peonId, sessionId]);
  let delivered = 0;
  for (const source of rows) {
    const events = await pendingEvents(source.id);
    if (events.length === 0) continue;
    const stintId = randomUUID();
    const done: string[] = [];
    for (const event of events) {
      // The event's own id is a UUID, so a retry of this flush is idempotent on Peon.
      const result = await callPeon(connOfRecord(record), "POST", `/sessions/${encodeURIComponent(sessionId)}/context-messages`, {
        actor,
        requestId: event.id,
        body: {
          text: stintPrompt(source.source_id, [event]).slice(0, 8_000),
          author: { kind: "guest", id: `source:${source.source_id}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 200), label: (event.author ?? source.source_id).slice(0, 80) },
          attachments: [],
          mentions: [],
        },
      });
      if (!result.ok) {
        const reason = (result.json as { error?: unknown } | null)?.error;
        throw new TriggerSourceError(502, "SOURCE_FLUSH_FAILED",
          `could not deliver the source's new messages before the decision${typeof reason === "string" ? `: ${reason}` : ""}`);
      }
      done.push(event.id);
    }
    await markDelivered(done, stintId, "context");
    await rearm(source.id, now);
    delivered += done.length;
  }
  return delivered;
}

let worker: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function fireDueSources(now = Date.now()): Promise<void> {
  await withAdvisoryLock("overseer:trigger-sources", async () => {
    const { rows } = await query<SourceRow>(
      `SELECT * FROM trigger_sources WHERE deadline_at IS NOT NULL AND deadline_at <= $1 ORDER BY deadline_at LIMIT 50`,
      [now],
    );
    for (const source of rows) {
      await fireSource(source, now).catch((error) =>
        fail(source.id, error instanceof Error ? error.message : "stint delivery failed", now));
    }
  });
}

export function startTriggerSourceWorker(): void {
  if (worker) return;
  const run = () => {
    if (running) return;
    running = true;
    void fireDueSources()
      .catch((error) => console.error("triggers: pass failed:", error instanceof Error ? error.message : error))
      .finally(() => { running = false; });
  };
  worker = setInterval(run, WORKER_MS);
  worker.unref();
}
