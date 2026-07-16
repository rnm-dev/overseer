import pg from "pg";
import { config } from "./config.js";
import { MIGRATIONS } from "./migrations.js";

// Postgres is the overseer's single system-of-record. This module owns the
// connection pool and an embedded, forward-only migration runner — no external
// migration tool, so a fresh VPS just needs a reachable DATABASE_URL and the
// schema builds itself on boot. Tests inject a pg-mem pool via setPool() so the
// SQL is exercised without a real server; the SQL is kept to portable basics
// (CREATE TABLE, ON CONFLICT, plain SELECT/WHERE/ORDER/LIMIT, jsonb params) so
// pg-mem and real Postgres behave identically.

// node-postgres returns BIGINT as a string (values can exceed JS safe ints). All
// our bigints are epoch-ms, comfortably inside Number range, so parse them back
// to numbers globally rather than sprinkling Number() at every call site.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

let pool: pg.Pool | null = null;
const observedPools = new WeakSet<pg.Pool>();
let advisoryLocksAvailable = true;

function observePool(p: pg.Pool): pg.Pool {
  if (observedPools.has(p)) return p;
  observedPools.add(p);
  // pg-pool emits `error` when an idle connection dies. Without a listener,
  // EventEmitter treats that as an uncaught exception and takes down the whole
  // API (and every WebSocket) for a routine database/network blip. The pool has
  // already evicted the broken client at this point; logging is sufficient and
  // the next query obtains a fresh connection.
  p.on("error", (err) => {
    console.error("overseer: idle postgres connection lost; pool will reconnect:", err.message);
  });
  return p;
}

export function setPool(p: pg.Pool): void {
  pool = observePool(p);
  // Injected pools are used by pg-mem, which does not implement PostgreSQL's
  // advisory-lock functions. Production initDb() restores this to true.
  advisoryLocksAvailable = false;
}

function requirePool(): pg.Pool {
  if (!pool) throw new Error("db not initialized — call initDb() first");
  return pool;
}

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  return requirePool().query<T>(text, params as unknown[] | undefined);
}

export interface Transaction {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>>;
}

export async function transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
  const client = await requirePool().connect();
  const tx: Transaction = {
    query: <R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]) =>
      client.query<R>(text, params as unknown[] | undefined),
  };
  try {
    await client.query("BEGIN");
    const result = await work(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// Run a process-wide job once across every app replica. Tests use an injected
// pg-mem pool and simply execute the callback because advisory locks are a
// PostgreSQL runtime facility, not part of the behavior under test.
export async function withAdvisoryLock<T>(name: string, work: () => Promise<T>): Promise<T | null> {
  if (!advisoryLocksAvailable) return work();
  const client = await requirePool().connect();
  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [name]);
    locked = rows[0]?.locked === true;
    if (!locked) return null;
    return await work();
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [name]).catch(() => undefined);
    client.release();
  }
}

export async function migrate(): Promise<void> {
  const run = async () => {
    await query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
    for (const m of MIGRATIONS) {
      await transaction(async (tx) => {
        const { rows } = await tx.query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [m.id]);
        if (rows.length > 0) return;
        for (const stmt of m.statements) await tx.query(stmt);
        await tx.query(`INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)`, [m.id, Date.now()]);
      });
    }
  };
  if (!advisoryLocksAvailable) return run();

  // Unlike the non-blocking worker lock, startup waits here: a second replica
  // should boot against the completed schema, never race the same migration.
  const client = await requirePool().connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext($1))`, ["overseer:migrations"]);
    await run();
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, ["overseer:migrations"]).catch(() => undefined);
    client.release();
  }
}

// Connect (unless a pool was injected for tests) and bring the schema up to date.
export async function initDb(injected?: pg.Pool): Promise<void> {
  if (injected) {
    pool = observePool(injected);
    advisoryLocksAvailable = false;
  } else {
    if (!config.databaseUrl) throw new Error("DATABASE_URL is not set — the overseer needs Postgres to boot");
    pool = observePool(new pg.Pool({
      connectionString: config.databaseUrl,
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10_000,
    }));
    advisoryLocksAvailable = true;
  }
  await migrate();
}
