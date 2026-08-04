import { createHash, randomUUID } from "node:crypto";
import { query } from "./infrastructure/db/index.js";
import type { PeonCallResult } from "./infrastructure/peonHttp/index.js";

const LEASE_MS = 35_000;

// A Peon accepts only one follow-up transition for a session at a time. Keep
// distinct command IDs in arrival order too: idempotency alone only coalesces
// retries of the same command and otherwise lets concurrent operators race.
const sessionQueues = new Map<string, Promise<void>>();

async function inSessionOrder<T>(peonId: string, sessionId: string, work: () => Promise<T>): Promise<T> {
  const key = `${peonId.length}:${peonId}${sessionId}`;
  const previous = sessionQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  sessionQueues.set(key, turn);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (sessionQueues.get(key) === turn) sessionQueues.delete(key);
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function validCommandId(value: unknown): value is string {
  // UUIDs are recommended, but older clients used opaque idempotency keys.
  // The database and downstream protocol both treat this value as text, so
  // retain those keys while bounding them and excluding control characters.
  return typeof value === "string"
    && value.length <= 255
    && value.trim().length > 0
    && /^[\x20-\x7e]+$/.test(value);
}

export async function runIdempotentFollowup(
  peonId: string,
  sessionId: string,
  commandId: string,
  body: unknown,
  execute: () => Promise<PeonCallResult>,
): Promise<PeonCallResult> {
  return inSessionOrder(peonId, sessionId, () => runIdempotentFollowupInOrder(peonId, sessionId, commandId, body, execute));
}

async function runIdempotentFollowupInOrder(
  peonId: string,
  sessionId: string,
  commandId: string,
  body: unknown,
  execute: () => Promise<PeonCallResult>,
): Promise<PeonCallResult> {
  const payloadHash = createHash("sha256").update(canonical(body)).digest("hex");
  const owner = randomUUID();
  for (;;) {
    const now = Date.now();
    const inserted = await query(
      `INSERT INTO followup_commands (peon_id, session_id, command_id, payload_hash, owner_id, lease_expires_at, created_at, request_body)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [peonId, sessionId, commandId, payloadHash, owner, now + LEASE_MS, now, JSON.stringify(body)],
    );
    let owns = (inserted.rowCount ?? 0) > 0;
    const { rows } = await query<{ payload_hash: string; response_status: number | null; response_body: unknown; lease_expires_at: number }>(
      `SELECT payload_hash, response_status, response_body, lease_expires_at FROM followup_commands WHERE peon_id=$1 AND session_id=$2 AND command_id=$3`,
      [peonId, sessionId, commandId],
    );
    const row = rows[0];
    if (!row) continue;
    if (row.payload_hash !== payloadHash) return { status: 409, ok: false, json: { error: "request ID was already used with a different payload", code: "IDEMPOTENCY_CONFLICT" } };
    if (row.response_status !== null) return { status: row.response_status, ok: row.response_status >= 200 && row.response_status < 300, json: row.response_body };
    if (!owns && row.lease_expires_at <= now) {
      const taken = await query(
        `UPDATE followup_commands SET owner_id=$4, lease_expires_at=$5 WHERE peon_id=$1 AND session_id=$2 AND command_id=$3 AND response_status IS NULL AND lease_expires_at <= $6`,
        [peonId, sessionId, commandId, owner, now + LEASE_MS, now],
      );
      owns = (taken.rowCount ?? 0) > 0;
    }
    if (!owns) { await pause(50); continue; }
    const result = await execute();
    if (result.ok) {
      await query(
        `UPDATE followup_commands SET response_status=$5, response_body=$6, completed_at=$7 WHERE peon_id=$1 AND session_id=$2 AND command_id=$3 AND owner_id=$4`,
        [peonId, sessionId, commandId, owner, result.status, result.json, Date.now()],
      );
    } else {
      await query(`DELETE FROM followup_commands WHERE peon_id=$1 AND session_id=$2 AND command_id=$3 AND owner_id=$4`, [peonId, sessionId, commandId, owner]);
    }
    return result;
  }
}
