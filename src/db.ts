import pg from "pg";
import { config } from "./config.js";

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

export function setPool(p: pg.Pool): void {
  pool = p;
}

function requirePool(): pg.Pool {
  if (!pool) throw new Error("db not initialized — call initDb() first");
  return pool;
}

export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  return requirePool().query<T>(text, params as unknown[] | undefined);
}

// Each migration is an ordered list of individual statements (one statement per
// query() call — widest-compatible across the real driver and pg-mem).
const MIGRATIONS: { id: string; statements: string[] }[] = [
  {
    id: "001_init",
    statements: [
      // Operator/mobile auth (see auth.ts).
      `CREATE TABLE IF NOT EXISTS users (
         id         TEXT PRIMARY KEY,
         email      TEXT NOT NULL UNIQUE,
         created_at BIGINT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS devices (
         id           TEXT PRIMARY KEY,
         user_id      TEXT NOT NULL,
         label        TEXT,
         token_hash   TEXT NOT NULL,
         created_at   BIGINT NOT NULL,
         last_seen_at BIGINT,
         expires_at   BIGINT NOT NULL,
         revoked_at   BIGINT,
         client_ip    TEXT,
         client_ua    TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id)`,
      `CREATE TABLE IF NOT EXISTS auth_challenges (
         id               TEXT PRIMARY KEY,
         email            TEXT NOT NULL,
         otp_hash         TEXT NOT NULL,
         link_hash        TEXT NOT NULL,
         device_label     TEXT,
         status           TEXT NOT NULL,
         attempts         INTEGER NOT NULL DEFAULT 0,
         created_at       BIGINT NOT NULL,
         expires_at       BIGINT NOT NULL,
         link_verified_at BIGINT,
         consumed_at      BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS auth_challenges_email_idx ON auth_challenges (email)`,

      // Multi-tenant workspaces (see workspaces.ts).
      `CREATE TABLE IF NOT EXISTS workspaces (
         id         TEXT PRIMARY KEY,
         name       TEXT NOT NULL,
         slug       TEXT NOT NULL UNIQUE,
         created_by TEXT,
         created_at BIGINT NOT NULL
       )`,
      `CREATE TABLE IF NOT EXISTS workspace_members (
         workspace_id TEXT NOT NULL,
         user_id      TEXT NOT NULL,
         role         TEXT NOT NULL,
         added_at     BIGINT NOT NULL,
         PRIMARY KEY (workspace_id, user_id)
       )`,
      `CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members (user_id)`,

      // Peon recruitment tokens (see credentials.ts). Stored raw (symmetric secret).
      `CREATE TABLE IF NOT EXISTS peon_credentials (
         id            TEXT PRIMARY KEY,
         workspace_id  TEXT NOT NULL,
         token         TEXT NOT NULL UNIQUE,
         label         TEXT,
         created_by    TEXT,
         created_at    BIGINT NOT NULL,
         revoked_at    BIGINT,
         bound_peon_id TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS peon_credentials_ws_idx ON peon_credentials (workspace_id)`,

      // The peon registry. `token` is the credential's token, denormalized here so
      // an outbound call needs no join. Online is derived from last_seen.
      `CREATE TABLE IF NOT EXISTS peons (
         peon_id          TEXT PRIMARY KEY,
         credential_id    TEXT NOT NULL,
         workspace_id     TEXT NOT NULL,
         name             TEXT NOT NULL,
         hostname         TEXT,
         address          TEXT NOT NULL,
         control_port     INTEGER NOT NULL,
         protocol         INTEGER,
         capabilities     JSONB NOT NULL DEFAULT '[]',
         load             JSONB,
         token            TEXT NOT NULL,
         registered_at    BIGINT NOT NULL,
         last_seen        BIGINT NOT NULL,
         last_event_epoch TEXT,
         last_event_seq   BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS peons_workspace_idx ON peons (workspace_id)`,

      // Aggregated session index (sessionIndex.ts) — a cache of every peon's sessions.
      `CREATE TABLE IF NOT EXISTS sessions (
         peon_id          TEXT NOT NULL,
         session_id       TEXT NOT NULL,
         status           TEXT,
         project_key      TEXT,
         title            TEXT,
         preview          TEXT,
         author           TEXT,
         outcome          JSONB,
         started_at       BIGINT,
         ended_at         BIGINT,
         last_activity_at BIGINT,
         raw              JSONB NOT NULL,
         synced_at        BIGINT NOT NULL,
         PRIMARY KEY (peon_id, session_id)
       )`,
      `CREATE INDEX IF NOT EXISTS sessions_status_idx ON sessions (status)`,
      `CREATE INDEX IF NOT EXISTS sessions_last_activity_idx ON sessions (last_activity_at)`,
      `CREATE INDEX IF NOT EXISTS sessions_peon_idx ON sessions (peon_id)`,
    ],
  },
  {
    // GitHub sign-in replaces magic-link/OTP. Users gain a GitHub identity;
    // workspace_invitations backs shareable join links (auth_challenges retired).
    id: "002_github_auth",
    statements: [
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
      // NULLs are distinct in a UNIQUE index, so legacy email-only rows coexist.
      `CREATE UNIQUE INDEX IF NOT EXISTS users_github_id_idx ON users (github_id)`,
      `CREATE TABLE IF NOT EXISTS workspace_invitations (
         id           TEXT PRIMARY KEY,
         workspace_id TEXT NOT NULL,
         token        TEXT NOT NULL UNIQUE,
         role         TEXT NOT NULL,
         created_by   TEXT,
         created_at   BIGINT NOT NULL,
         expires_at   BIGINT,
         revoked_at   BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS workspace_invitations_ws_idx ON workspace_invitations (workspace_id)`,
      `DROP TABLE IF EXISTS auth_challenges`,
    ],
  },
  {
    // Append-only event log — the resumable-client backbone (liveSocket.ts). The
    // global `cursor` is the client resume token; a reconnecting app replays
    // events past its last cursor instead of re-fetching everything.
    id: "003_events",
    statements: [
      `CREATE TABLE IF NOT EXISTS events (
         cursor       BIGSERIAL PRIMARY KEY,
         workspace_id TEXT   NOT NULL,
         peon_id      TEXT   NOT NULL,
         session_id   TEXT,
         kind         TEXT   NOT NULL,
         payload      JSONB  NOT NULL,
         created_at   BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS events_ws_cursor_idx ON events (workspace_id, cursor)`,
    ],
  },
  {
    // Operator-pinned call-back address. When set, register() must NOT overwrite
    // address/control_port from the (NAT-observed) source + self-reported port —
    // the operator's manual value is authoritative and survives peon restarts.
    id: "004_peon_connection_pin",
    statements: [`ALTER TABLE peons ADD COLUMN IF NOT EXISTS connection_pinned BOOLEAN NOT NULL DEFAULT FALSE`],
  },
];

export async function migrate(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)`);
  for (const m of MIGRATIONS) {
    const { rows } = await query(`SELECT 1 FROM schema_migrations WHERE id = $1`, [m.id]);
    if (rows.length > 0) continue;
    for (const stmt of m.statements) await query(stmt);
    await query(`INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)`, [m.id, Date.now()]);
  }
}

// Connect (unless a pool was injected for tests) and bring the schema up to date.
export async function initDb(injected?: pg.Pool): Promise<void> {
  if (injected) {
    pool = injected;
  } else {
    if (!config.databaseUrl) throw new Error("DATABASE_URL is not set — the overseer needs Postgres to boot");
    pool = new pg.Pool({ connectionString: config.databaseUrl });
  }
  await migrate();
}
