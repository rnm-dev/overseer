// Each migration is an ordered list of individual statements (one statement per
// query() call — widest-compatible across the real driver and pg-mem).
export const MIGRATIONS: { id: string; statements: string[] }[] = [
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
  {
    id: "005_native_oauth_and_followup_idempotency",
    statements: [
      `CREATE TABLE IF NOT EXISTS native_oauth_attempts (
         state_hash    TEXT PRIMARY KEY,
         callback_url TEXT NOT NULL,
         created_at   BIGINT NOT NULL,
         expires_at   BIGINT NOT NULL,
         app_code_hash TEXT,
         user_id      TEXT,
         code_expires_at BIGINT,
         completed_at BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS native_oauth_expiry_idx ON native_oauth_attempts (expires_at)`,
      `CREATE TABLE IF NOT EXISTS followup_commands (
         peon_id       TEXT NOT NULL,
         session_id    TEXT NOT NULL,
         command_id    TEXT NOT NULL,
         payload_hash  TEXT NOT NULL,
         owner_id      TEXT NOT NULL,
         lease_expires_at BIGINT NOT NULL,
         response_status INTEGER,
         response_body JSONB,
         created_at    BIGINT NOT NULL,
         completed_at  BIGINT,
         PRIMARY KEY (peon_id, session_id, command_id)
       )`,
    ],
  },
  {
    // Native push registrations are separate from login devices: one login can
    // have multiple app installations, and OS push tokens rotate independently.
    // The outbox makes event -> notification delivery restart-safe.
    id: "006_push_notifications",
    statements: [
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
         id          TEXT PRIMARY KEY,
         user_id     TEXT NOT NULL,
         device_id   TEXT NOT NULL,
         provider    TEXT NOT NULL,
         platform    TEXT NOT NULL,
         token       TEXT NOT NULL,
         app_id      TEXT,
         created_at  BIGINT NOT NULL,
         updated_at  BIGINT NOT NULL,
         disabled_at BIGINT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_provider_token_idx ON push_subscriptions (provider, token)`,
      `CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions (user_id)`,
      `CREATE TABLE IF NOT EXISTS push_preferences (
         user_id       TEXT NOT NULL,
         workspace_id  TEXT NOT NULL,
         enabled       BOOLEAN NOT NULL DEFAULT TRUE,
         session_events BOOLEAN NOT NULL DEFAULT TRUE,
         peon_events   BOOLEAN NOT NULL DEFAULT TRUE,
         updated_at    BIGINT NOT NULL,
         PRIMARY KEY (user_id, workspace_id)
       )`,
      `CREATE TABLE IF NOT EXISTS push_outbox (
         id              TEXT PRIMARY KEY,
         event_cursor    BIGINT NOT NULL,
         subscription_id TEXT NOT NULL,
         payload         JSONB NOT NULL,
         attempts        INTEGER NOT NULL DEFAULT 0,
         available_at    BIGINT NOT NULL,
         delivered_at    BIGINT,
         last_error      TEXT,
         created_at      BIGINT NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS push_outbox_event_subscription_idx ON push_outbox (event_cursor, subscription_id)`,
      `CREATE INDEX IF NOT EXISTS push_outbox_pending_idx ON push_outbox (delivered_at, available_at)`,
    ],
  },
  {
    // One pending organization member per invitation. Accepted links are
    // retained for auditability but can never be used by a second account.
    id: "007_individual_workspace_invitations",
    statements: [
      `ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS invitee_label TEXT`,
      `ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS accepted_by TEXT`,
      `ALTER TABLE workspace_invitations ADD COLUMN IF NOT EXISTS accepted_at BIGINT`,
    ],
  },
  {
    id: "008_member_resource_access",
    statements: [
      `CREATE TABLE IF NOT EXISTS workspace_member_peon_access (
         workspace_id TEXT NOT NULL,
         user_id      TEXT NOT NULL,
         peon_id      TEXT NOT NULL,
         granted_at   BIGINT NOT NULL,
         granted_by   TEXT,
         PRIMARY KEY (workspace_id, user_id, peon_id)
       )`,
      `CREATE INDEX IF NOT EXISTS member_peon_access_user_idx ON workspace_member_peon_access (workspace_id, user_id)`,
      `CREATE TABLE IF NOT EXISTS workspace_member_project_access (
         workspace_id TEXT NOT NULL,
         user_id      TEXT NOT NULL,
         peon_id      TEXT NOT NULL,
         project_key  TEXT NOT NULL,
         granted_at   BIGINT NOT NULL,
         granted_by   TEXT,
         PRIMARY KEY (workspace_id, user_id, peon_id, project_key)
       )`,
      `CREATE INDEX IF NOT EXISTS member_project_access_user_idx ON workspace_member_project_access (workspace_id, user_id, peon_id)`,
    ],
  },
  {
    // Peon transcripts from older builds omit user-message timestamps. Retain
    // the submitted body alongside the idempotency record so Overseer can add
    // the authoritative receive time when serving transcript history.
    id: "009_followup_request_body",
    statements: [`ALTER TABLE followup_commands ADD COLUMN IF NOT EXISTS request_body JSONB`],
  },
  {
    // Web and native GitHub OAuth share one registered HTTPS callback. Flow and
    // redirect data are server-backed so state carries no trusted routing data.
    id: "010_shared_github_oauth_callback",
    statements: [
      `CREATE TABLE IF NOT EXISTS oauth_attempts (
         state_hash      TEXT PRIMARY KEY,
         flow            TEXT NOT NULL,
         callback_url    TEXT NOT NULL,
         created_at      BIGINT NOT NULL,
         expires_at      BIGINT NOT NULL,
         app_code_hash   TEXT,
         user_id         TEXT,
         code_expires_at BIGINT,
         completed_at    BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS oauth_attempts_expiry_idx ON oauth_attempts (expires_at)`,
    ],
  },
  {
    // Canonical callback identity. Legacy address/control_port remain populated
    // for old rows and discovery-only Peons, but can no longer override this URL.
    id: "011_peon_canonical_address",
    statements: [
      `ALTER TABLE peons ADD COLUMN IF NOT EXISTS public_url TEXT`,
      `ALTER TABLE peons ADD COLUMN IF NOT EXISTS address_source TEXT`,
      `UPDATE peons SET address_source = CASE WHEN connection_pinned THEN 'manual' ELSE 'discovered' END WHERE address_source IS NULL`,
      `ALTER TABLE peons ALTER COLUMN address_source SET DEFAULT 'discovered'`,
      `ALTER TABLE peons ALTER COLUMN address_source SET NOT NULL`,
    ],
  },
  {
    // Browser WebSockets cannot attach an Authorization header. Exchange the
    // long-lived device credential for a short-lived, single-use handshake
    // ticket so credentials never appear in proxy-visible request URLs.
    id: "012_websocket_tickets",
    statements: [
      `CREATE TABLE IF NOT EXISTS websocket_tickets (
         ticket_hash TEXT PRIMARY KEY,
         user_id     TEXT NOT NULL,
         device_id   TEXT NOT NULL,
         created_at  BIGINT NOT NULL,
         expires_at  BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS websocket_tickets_expiry_idx ON websocket_tickets (expires_at)`,
    ],
  },
  {
    // Project keys are mutable labels. Peon-issued project IDs are the durable
    // identity used by session indexing and member ACLs; nullable columns keep
    // rolling upgrades and unresolved legacy grants safe.
    id: "013_stable_project_ids",
    statements: [
      `ALTER TABLE sessions ADD COLUMN IF NOT EXISTS project_id TEXT`,
      `CREATE INDEX IF NOT EXISTS sessions_project_id_idx ON sessions (peon_id, project_id)`,
      `ALTER TABLE workspace_member_project_access ADD COLUMN IF NOT EXISTS project_id TEXT`,
      `CREATE INDEX IF NOT EXISTS member_project_access_id_idx ON workspace_member_project_access (workspace_id, user_id, peon_id, project_id)`,
    ],
  },
  {
    // Keep the bounded first-message label separate from latest activity text.
    id: "014_session_prompt_preview",
    statements: [`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS prompt_preview TEXT`],
  },
  {
    // Global, immutable Peon releases. Archive bytes live on the configured
    // persistent volume; Postgres remains the metadata system of record.
    id: "015_peon_releases",
    statements: [
      `CREATE TABLE IF NOT EXISTS releases (
         version     TEXT PRIMARY KEY,
         storage_key TEXT NOT NULL,
         size         BIGINT NOT NULL,
         sha256       TEXT NOT NULL,
         created_at   BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS releases_created_idx ON releases (created_at)`,
    ],
  },
  {
    // Durable resume point for the reverse-connected session catalog. Cursors
    // are Peon-owned opaque strings; never interpret them as clocks or offsets.
    id: "016_peon_session_sync",
    statements: [
      `CREATE TABLE IF NOT EXISTS peon_session_sync (
         peon_id    TEXT PRIMARY KEY,
         epoch      TEXT,
         cursor     TEXT,
         status     TEXT NOT NULL,
         updated_at BIGINT NOT NULL
       )`,
    ],
  },
  {
    // Generation fencing prevents a replaced socket from committing late. The
    // inbox makes Peon cursor ingestion durable and idempotent across restarts.
    id: "017_session_sync_hardening",
    statements: [
      `ALTER TABLE peon_session_sync ADD COLUMN IF NOT EXISTS generation TEXT`,
      `CREATE TABLE IF NOT EXISTS peon_session_inbox (
         peon_id    TEXT NOT NULL,
         epoch      TEXT NOT NULL,
         cursor     TEXT NOT NULL,
         created_at BIGINT NOT NULL,
         PRIMARY KEY (peon_id, epoch, cursor)
       )`,
    ],
  },
  {
    // The canonical protocol has independent catalog and durable-delivery
    // epochs/checkpoints. Keep the old columns in place for rollback, but do
    // not reinterpret checkpoints written by the retired sessions.* dialect.
    id: "018_canonical_session_catalog",
    statements: [
      `ALTER TABLE peon_session_sync ADD COLUMN IF NOT EXISTS catalog_epoch TEXT`,
      `ALTER TABLE peon_session_sync ADD COLUMN IF NOT EXISTS acknowledged_seq BIGINT`,
      `ALTER TABLE peon_session_sync ADD COLUMN IF NOT EXISTS delivery_epoch TEXT`,
      `ALTER TABLE peon_session_sync ADD COLUMN IF NOT EXISTS acknowledged_cursor TEXT`,
      `ALTER TABLE peon_session_inbox ADD COLUMN IF NOT EXISTS message_id TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS peon_session_inbox_message_id_idx ON peon_session_inbox (peon_id, message_id) WHERE message_id IS NOT NULL`,
    ],
  },
  {
    // Peon remains authoritative for projects. This materialized projection is
    // keyed by the immutable Peon-issued ID; project_key is mutable navigation
    // metadata and must never become an authorization identity again.
    id: "019_project_catalog",
    statements: [
      `CREATE TABLE IF NOT EXISTS projects (
         peon_id     TEXT NOT NULL,
         project_id  TEXT NOT NULL,
         project_key TEXT NOT NULL,
         name         TEXT,
         dir          TEXT,
         metadata     TEXT,
         synced_at    BIGINT NOT NULL,
         PRIMARY KEY (peon_id, project_id)
       )`,
      `CREATE INDEX IF NOT EXISTS projects_peon_key_idx ON projects (peon_id, project_key)`,
      `CREATE TABLE IF NOT EXISTS peon_project_sync (
         peon_id          TEXT PRIMARY KEY,
         catalog_epoch    TEXT,
         acknowledged_seq BIGINT,
         status           TEXT NOT NULL,
         updated_at       BIGINT NOT NULL,
         generation       TEXT
       )`,
    ],
  },
];
