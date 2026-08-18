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
  {
    // Per-user, per-run attention survives refreshes and synchronizes between
    // devices. A row starts pending when a command is accepted, becomes unread
    // when that run completes, and becomes read when the user opens the session.
    id: "020_session_attention",
    statements: [
      `CREATE TABLE IF NOT EXISTS session_attention (
         workspace_id  TEXT NOT NULL,
         user_id       TEXT NOT NULL,
         peon_id       TEXT NOT NULL,
         session_id    TEXT NOT NULL,
         occurrence_key TEXT NOT NULL,
         state         TEXT NOT NULL,
         requested_at  BIGINT NOT NULL,
         completed_at  BIGINT,
         read_at       BIGINT,
         PRIMARY KEY (user_id, peon_id, session_id, occurrence_key)
       )`,
      `CREATE INDEX IF NOT EXISTS session_attention_unread_idx ON session_attention (workspace_id, user_id, state, requested_at)`,
      `CREATE INDEX IF NOT EXISTS session_attention_session_idx ON session_attention (peon_id, session_id, state, requested_at)`,
    ],
  },
  {
    // Peon owns project quick links. Overseer keeps only the catalog-backed
    // projection so links remain visible while the Peon is temporarily offline.
    id: "021_project_quick_links",
    statements: [
      `ALTER TABLE projects ADD COLUMN IF NOT EXISTS quick_links JSONB NOT NULL DEFAULT '[]'::jsonb`,
    ],
  },
  {
    // A Live Activity is one aggregate per operator per device connection —
    // never one per session — so both tables are keyed by that scope rather
    // than by a session. ActivityKit's tokens are not FCM registration tokens
    // and live in their own table: the push-to-start token survives the app
    // being terminated, and the update token exists only for as long as the
    // activity ActivityKit handed it back for.
    //
    // The claim row is the duplicate-suppressor: its primary key is the scope,
    // so a conditional UPDATE off `state='idle'` is what makes two simultaneous
    // "first session started" events produce exactly one start push.
    id: "022_live_activities",
    statements: [
      `CREATE TABLE IF NOT EXISTS live_activity_tokens (
         id            TEXT PRIMARY KEY,
         user_id       TEXT NOT NULL,
         device_id     TEXT NOT NULL,
         connection_id TEXT NOT NULL,
         kind          TEXT NOT NULL,
         activity_id   TEXT,
         token         TEXT NOT NULL,
         bundle_id     TEXT,
         created_at    BIGINT NOT NULL,
         updated_at    BIGINT NOT NULL,
         disabled_at   BIGINT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS live_activity_tokens_scope_idx ON live_activity_tokens (user_id, device_id, connection_id, kind)`,
      `CREATE INDEX IF NOT EXISTS live_activity_tokens_user_idx ON live_activity_tokens (user_id)`,
      `CREATE TABLE IF NOT EXISTS live_activity_claims (
         user_id            TEXT NOT NULL,
         device_id          TEXT NOT NULL,
         connection_id      TEXT NOT NULL,
         state              TEXT NOT NULL,
         activity_id        TEXT,
         running_count      INTEGER NOT NULL DEFAULT 0,
         completed_count    INTEGER NOT NULL DEFAULT 0,
         oldest_started_at  BIGINT,
         content_updated_at BIGINT NOT NULL DEFAULT 0,
         started_at         BIGINT,
         ended_at           BIGINT,
         updated_at         BIGINT NOT NULL,
         last_error         TEXT,
         PRIMARY KEY (user_id, device_id, connection_id)
       )`,
      `CREATE INDEX IF NOT EXISTS live_activity_claims_user_idx ON live_activity_claims (user_id)`,
    ],
  },
  {
    // `state` answers "did the operator see the answer"; it cannot also answer
    // "did the run finish", because opening a still-running session retires an
    // occurrence to `read` while its execution is still in flight. `resolved_at`
    // is the lifecycle half: set FIFO as runs complete, regardless of what the
    // operator has read. Backfill resolves every non-pending occurrence — a
    // pending row is by construction one whose completion never arrived.
    id: "023_session_attention_lifecycle",
    statements: [
      `ALTER TABLE session_attention ADD COLUMN IF NOT EXISTS resolved_at BIGINT`,
      `UPDATE session_attention SET resolved_at = COALESCE(completed_at, read_at, requested_at)
         WHERE resolved_at IS NULL AND state <> 'pending'`,
      `CREATE INDEX IF NOT EXISTS session_attention_outstanding_idx ON session_attention (peon_id, session_id, resolved_at, requested_at)`,
    ],
  },
  {
    // Shared Overseer-side half of reverse-command-v1. The command row is the
    // restart-safe correlation/pending registry; terminal audit is separate so
    // command compaction can never erase who requested an effect. Durable
    // result messages continue to use the one Peon-wide inbox/checkpoint.
    id: "024_reverse_commands",
    statements: [
      `CREATE TABLE IF NOT EXISTS reverse_commands (
         workspace_id          TEXT NOT NULL,
         peon_id               TEXT NOT NULL,
         command_id            TEXT NOT NULL,
         operation             TEXT NOT NULL,
         request_hash          TEXT NOT NULL,
         actor_user_id         TEXT NOT NULL,
         actor_email           TEXT NOT NULL,
         target                JSONB NOT NULL,
         payload               JSONB NOT NULL,
         expected              JSONB,
         request_bytes         BIGINT NOT NULL,
         state                 TEXT NOT NULL,
         connection_generation TEXT,
         requested_at          BIGINT NOT NULL,
         sent_at               BIGINT,
         accepted_at           BIGINT,
         completed_at          BIGINT,
         updated_at            BIGINT NOT NULL,
         terminal_status       TEXT,
         result_code           TEXT,
         result_message        TEXT,
         terminal_result       JSONB,
         result_frame          JSONB,
         replayed              BOOLEAN NOT NULL DEFAULT FALSE,
         attempt_count         INTEGER NOT NULL DEFAULT 0,
         last_error_code       TEXT,
         durable_committed_at  BIGINT,
         PRIMARY KEY (workspace_id, peon_id, command_id)
       )`,
      `CREATE INDEX IF NOT EXISTS reverse_commands_pending_idx ON reverse_commands (workspace_id, peon_id, state, updated_at)`,
      `CREATE INDEX IF NOT EXISTS reverse_commands_actor_idx ON reverse_commands (workspace_id, actor_user_id, state)`,
      `CREATE TABLE IF NOT EXISTS reverse_command_audit (
         workspace_id TEXT NOT NULL,
         peon_id      TEXT NOT NULL,
         command_id   TEXT NOT NULL,
         user_id      TEXT NOT NULL,
         operation    TEXT NOT NULL,
         event        TEXT NOT NULL,
         result_status TEXT,
         result_code  TEXT,
         created_at   BIGINT NOT NULL,
         PRIMARY KEY (workspace_id, peon_id, command_id, event)
      )`,
      `CREATE INDEX IF NOT EXISTS reverse_command_audit_peon_idx ON reverse_command_audit (workspace_id, peon_id, created_at)`,
    ],
  },
  {
    // peon-claim-v1 separates stable machine identity, one-time encrypted
    // delivery and long-lived keyed credential verification. No raw pc1 bearer
    // is stored in either the registry or the normal credential row.
    id: "025_peon_claim_v1",
    statements: [
      `CREATE TABLE IF NOT EXISTS peon_identity_bindings (
         peon_id        TEXT PRIMARY KEY,
         identity_key_id TEXT NOT NULL,
         public_jwk     JSONB NOT NULL,
         workspace_id   TEXT NOT NULL,
         method         TEXT NOT NULL,
         created_at     BIGINT NOT NULL,
         removed_at     BIGINT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS peon_identity_key_idx ON peon_identity_bindings (identity_key_id)`,
      `CREATE TABLE IF NOT EXISTS peon_enrollment_leases (
         peon_id         TEXT PRIMARY KEY,
         identity_key_id TEXT NOT NULL,
         method          TEXT NOT NULL,
         claim_id        TEXT,
         created_at      BIGINT NOT NULL,
         expires_at      BIGINT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS peon_enrollment_identity_lease_idx ON peon_enrollment_leases (identity_key_id)`,
      `CREATE TABLE IF NOT EXISTS peon_claims (
         claim_id          TEXT PRIMARY KEY,
         attempt_id        TEXT NOT NULL UNIQUE,
         request_hash      TEXT NOT NULL,
         peon_id           TEXT NOT NULL,
         identity_key_id   TEXT NOT NULL,
         public_jwk        JSONB NOT NULL,
         claim_nonce       TEXT NOT NULL,
         server_origin     TEXT NOT NULL,
         claim_token_hash  TEXT,
         operator_code_hash TEXT UNIQUE,
         operator_code_key_version INTEGER,
         operator_code_nonce TEXT,
         operator_code_ciphertext TEXT,
         operator_code_tag TEXT,
         display           JSONB NOT NULL,
         state             TEXT NOT NULL,
         mode              TEXT,
         workspace_id      TEXT,
         decided_by        TEXT,
         decision          TEXT,
         credential_id     TEXT,
         delivery_id       TEXT,
         created_at        BIGINT NOT NULL,
         expires_at        BIGINT NOT NULL,
         delivery_expires_at BIGINT,
         delivered_at      BIGINT,
         terminal_at       BIGINT,
         terminal_polled_at BIGINT,
         completed_at      BIGINT,
         ack_request_hash  TEXT,
         ack_result_expires_at BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS peon_claims_identity_state_idx ON peon_claims (peon_id, identity_key_id, state)`,
      `CREATE INDEX IF NOT EXISTS peon_claims_expiry_idx ON peon_claims (state, expires_at, delivery_expires_at)`,
      `CREATE TABLE IF NOT EXISTS peon_claim_resolutions (
         claim_id    TEXT NOT NULL,
         user_id     TEXT NOT NULL,
         resolved_at BIGINT NOT NULL,
         expires_at  BIGINT NOT NULL,
         PRIMARY KEY (claim_id, user_id)
       )`,
      `CREATE TABLE IF NOT EXISTS peon_claim_attempts (
         attempt_id       TEXT PRIMARY KEY,
         request_hash     TEXT NOT NULL,
         claim_id         TEXT NOT NULL,
         terminal_at      BIGINT,
         tombstone_expires_at BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS peon_claim_attempts_expiry_idx ON peon_claim_attempts (tombstone_expires_at)`,
      `CREATE TABLE IF NOT EXISTS peon_claim_credentials (
         id               TEXT PRIMARY KEY,
         workspace_id     TEXT NOT NULL,
         peon_id          TEXT NOT NULL,
         identity_key_id  TEXT NOT NULL,
         generation       INTEGER NOT NULL,
         state            TEXT NOT NULL,
         verifier         TEXT NOT NULL,
         pepper_version   INTEGER NOT NULL,
         created_by       TEXT,
         created_at       BIGINT NOT NULL,
         activated_at     BIGINT,
         retiring_at      BIGINT,
         old_socket_grace_ends_at BIGINT,
         revoked_at       BIGINT
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS peon_claim_credentials_generation_idx ON peon_claim_credentials (peon_id, generation)`,
      `CREATE INDEX IF NOT EXISTS peon_claim_credentials_active_idx ON peon_claim_credentials (workspace_id, peon_id, state)`,
      `CREATE TABLE IF NOT EXISTS peon_claim_deliveries (
         delivery_id      TEXT PRIMARY KEY,
         owner_type       TEXT NOT NULL,
         owner_id         TEXT NOT NULL UNIQUE,
         credential_id    TEXT NOT NULL,
         peon_id          TEXT NOT NULL,
         workspace_id     TEXT NOT NULL,
         identity_key_id  TEXT NOT NULL,
         generation       INTEGER NOT NULL,
         key_version      INTEGER NOT NULL,
         nonce            TEXT NOT NULL,
         ciphertext       TEXT NOT NULL,
         tag               TEXT NOT NULL,
         created_at       BIGINT NOT NULL,
         expires_at       BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS peon_claim_deliveries_expiry_idx ON peon_claim_deliveries (expires_at)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS peon_claim_delivery_nonce_idx ON peon_claim_deliveries (key_version, nonce)`,
      `CREATE TABLE IF NOT EXISTS peon_credential_rotations (
         rotation_id       TEXT PRIMARY KEY,
         request_hash      TEXT NOT NULL,
         peon_id           TEXT NOT NULL,
         workspace_id      TEXT NOT NULL,
         identity_key_id   TEXT NOT NULL,
         previous_credential_id TEXT NOT NULL,
         previous_generation INTEGER NOT NULL,
         credential_id     TEXT NOT NULL,
         delivery_id       TEXT NOT NULL,
         state             TEXT NOT NULL,
         created_at        BIGINT NOT NULL,
         expires_at        BIGINT NOT NULL,
         delivered_at      BIGINT,
         completed_at      BIGINT,
         old_socket_grace_ends_at BIGINT,
         terminal_at       BIGINT,
         ack_request_hash  TEXT,
         ack_result_expires_at BIGINT,
         tombstone_expires_at BIGINT
       )`,
      `CREATE INDEX IF NOT EXISTS peon_rotations_active_idx ON peon_credential_rotations (peon_id, state)`,
      `CREATE TABLE IF NOT EXISTS peon_claim_request_nonces (
         identity_key_id TEXT NOT NULL,
         request_nonce   TEXT NOT NULL,
         created_at      BIGINT NOT NULL,
         expires_at      BIGINT NOT NULL,
         PRIMARY KEY (identity_key_id, request_nonce)
       )`,
      `CREATE INDEX IF NOT EXISTS peon_claim_nonces_expiry_idx ON peon_claim_request_nonces (expires_at)`,
      `CREATE TABLE IF NOT EXISTS peon_claim_rate_limits (
         scope        TEXT NOT NULL,
         subject_hash TEXT NOT NULL,
         window_start BIGINT NOT NULL,
         count        INTEGER NOT NULL,
         PRIMARY KEY (scope, subject_hash, window_start)
       )`,
      `CREATE TABLE IF NOT EXISTS peon_claim_audit (
         id           TEXT PRIMARY KEY,
         workspace_id TEXT,
         peon_id      TEXT,
         claim_id     TEXT,
         credential_id TEXT,
         actor_user_id TEXT,
         event        TEXT NOT NULL,
         stable_code  TEXT,
         request_id   TEXT,
         scope        TEXT,
         outcome      TEXT,
         revoked_at   BIGINT,
         created_at   BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS peon_claim_audit_workspace_idx ON peon_claim_audit (workspace_id, created_at)`,
    ],
  },
  {
    // OVSR-131 scopes command IDs to a Peon. Re-key installations where the
    // initial unreleased migration used the broader workspace-only identity.
    id: "026_reverse_commands_peon_scope",
    statements: [
      `ALTER TABLE reverse_commands DROP CONSTRAINT IF EXISTS reverse_commands_pkey`,
      `ALTER TABLE reverse_commands ADD PRIMARY KEY (workspace_id, peon_id, command_id)`,
      `ALTER TABLE reverse_command_audit DROP CONSTRAINT IF EXISTS reverse_command_audit_pkey`,
      `ALTER TABLE reverse_command_audit ADD PRIMARY KEY (workspace_id, peon_id, command_id, event)`,
    ],
  },
  {
    // Reverse transcript history is a rebuildable, session-scoped projection.
    // A snapshot replaces one whole session atomically; live rows and the
    // shared durable-delivery checkpoint commit in the same transaction.
    id: "027_transcript_projection",
    statements: [
      `CREATE TABLE IF NOT EXISTS peon_transcript_sync (
         peon_id          TEXT NOT NULL,
         session_id       TEXT NOT NULL,
         workspace_id     TEXT NOT NULL,
         transcript_epoch TEXT,
         acknowledged_seq BIGINT,
         revision          BIGINT,
         barrier_seq       BIGINT,
         status            TEXT NOT NULL,
         generation        TEXT,
         event_count       INTEGER NOT NULL DEFAULT 0,
         body_bytes        BIGINT NOT NULL DEFAULT 0,
         updated_at        BIGINT NOT NULL,
         last_accessed_at  BIGINT NOT NULL,
         PRIMARY KEY (peon_id, session_id)
       )`,
      `CREATE INDEX IF NOT EXISTS peon_transcript_sync_retention_idx
         ON peon_transcript_sync (status, last_accessed_at)`,
      `CREATE TABLE IF NOT EXISTS transcript_events (
         peon_id          TEXT NOT NULL,
         session_id       TEXT NOT NULL,
         transcript_epoch TEXT NOT NULL,
         seq               BIGINT NOT NULL,
         event_id          TEXT NOT NULL,
         payload           JSONB NOT NULL,
         body_bytes        BIGINT NOT NULL,
         created_at        BIGINT NOT NULL,
         PRIMARY KEY (peon_id, session_id, transcript_epoch, seq)
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS transcript_events_identity_idx
         ON transcript_events (peon_id, session_id, event_id)`,
      `CREATE INDEX IF NOT EXISTS transcript_events_page_idx
         ON transcript_events (peon_id, session_id, seq)`,
    ],
  },
  {
    // Final frozen peon-claim-v1 adds separately sealed operator-code replay,
    // semantic ACK retention, exact terminal/tombstone boundaries and
    // revocation audit outcomes. This remains additive for any development
    // database that observed the provisional migration.
    id: "028_peon_claim_final_contract",
    statements: [
      `ALTER TABLE peon_claims ADD COLUMN IF NOT EXISTS server_origin TEXT`,
      `ALTER TABLE peon_claims ADD COLUMN IF NOT EXISTS operator_code_key_version INTEGER`,
      `ALTER TABLE peon_claims ADD COLUMN IF NOT EXISTS operator_code_nonce TEXT`,
      `ALTER TABLE peon_claims ADD COLUMN IF NOT EXISTS operator_code_ciphertext TEXT`,
      `ALTER TABLE peon_claims ADD COLUMN IF NOT EXISTS operator_code_tag TEXT`,
      `ALTER TABLE peon_claims ADD COLUMN IF NOT EXISTS ack_request_hash TEXT`,
      `ALTER TABLE peon_claims ADD COLUMN IF NOT EXISTS ack_result_expires_at BIGINT`,
      `ALTER TABLE peon_claim_attempts ADD COLUMN IF NOT EXISTS terminal_at BIGINT`,
      `ALTER TABLE peon_claim_attempts ALTER COLUMN tombstone_expires_at DROP NOT NULL`,
      `ALTER TABLE peon_credential_rotations ADD COLUMN IF NOT EXISTS terminal_at BIGINT`,
      `ALTER TABLE peon_credential_rotations ADD COLUMN IF NOT EXISTS ack_request_hash TEXT`,
      `ALTER TABLE peon_credential_rotations ADD COLUMN IF NOT EXISTS ack_result_expires_at BIGINT`,
      `ALTER TABLE peon_credential_rotations ALTER COLUMN tombstone_expires_at DROP NOT NULL`,
      `ALTER TABLE peon_claim_audit ADD COLUMN IF NOT EXISTS request_id TEXT`,
      `ALTER TABLE peon_claim_audit ADD COLUMN IF NOT EXISTS scope TEXT`,
      `ALTER TABLE peon_claim_audit ADD COLUMN IF NOT EXISTS outcome TEXT`,
      `ALTER TABLE peon_claim_audit ADD COLUMN IF NOT EXISTS revoked_at BIGINT`,
      `CREATE TABLE IF NOT EXISTS peon_claim_ack_auth (
         claim_id       TEXT PRIMARY KEY,
         delivery_id    TEXT NOT NULL,
         credential_id  TEXT NOT NULL,
         peon_id        TEXT NOT NULL,
         identity_key_id TEXT NOT NULL,
         public_jwk     JSONB NOT NULL,
         claim_nonce    TEXT NOT NULL,
         server_origin  TEXT NOT NULL,
         generation     INTEGER NOT NULL,
         expires_at     BIGINT NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS peon_claim_ack_auth_expiry_idx ON peon_claim_ack_auth (expires_at)`,
      `CREATE TABLE IF NOT EXISTS peon_claim_peon_revocations (
         peon_id      TEXT PRIMARY KEY,
         workspace_id TEXT NOT NULL,
         revoked_at   BIGINT NOT NULL
       )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS peon_claim_delivery_nonce_idx ON peon_claim_deliveries (key_version, nonce)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS peon_claim_operator_code_nonce_idx ON peon_claims (operator_code_key_version, operator_code_nonce)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS peon_enrollment_identity_lease_idx ON peon_enrollment_leases (identity_key_id)`,
    ],
  },
  {
    id: "029_daemon_configuration_projection",
    statements: [
      `CREATE TABLE IF NOT EXISTS peon_daemon_configuration (
         peon_id         TEXT PRIMARY KEY,
         workspace_id    TEXT NOT NULL,
         epoch           TEXT NOT NULL,
         revision        BIGINT NOT NULL,
         schema_version  INTEGER NOT NULL,
         digest          TEXT NOT NULL,
         updated_at      BIGINT NOT NULL,
         values          JSONB NOT NULL,
         last_command_id TEXT
       )`,
      `CREATE INDEX IF NOT EXISTS peon_daemon_configuration_workspace_idx
         ON peon_daemon_configuration (workspace_id, peon_id)`,
    ],
  },
  {
    id: "030_runtime_state_projection",
    statements: [
      `CREATE TABLE IF NOT EXISTS peon_runtime_state (
         peon_id       TEXT PRIMARY KEY,
         workspace_id  TEXT NOT NULL,
         epoch         TEXT NOT NULL,
         revision      BIGINT NOT NULL,
         digest        TEXT NOT NULL,
         generated_at  BIGINT NOT NULL,
         received_at   BIGINT NOT NULL,
         state         JSONB NOT NULL
       )`,
      `CREATE INDEX IF NOT EXISTS peon_runtime_state_workspace_idx
         ON peon_runtime_state (workspace_id, peon_id)`,
    ],
  },
  {
    // Historical attachment receipts are retained for already-recorded rows.
    // Receipts are durable because the Peon's completed-write replay cache is
    // intentionally process-local and cannot prove a commit after restart.
    id: "031_attachment_transfer_receipts",
    statements: [
      `CREATE TABLE IF NOT EXISTS attachment_transfer_receipts (
         receipt_id         TEXT PRIMARY KEY,
         workspace_id       TEXT NOT NULL,
         peon_id            TEXT NOT NULL,
         transfer_id        TEXT NOT NULL,
         actor_user_id      TEXT NOT NULL,
         actor_email        TEXT NOT NULL,
         path               TEXT NOT NULL,
         size               BIGINT NOT NULL,
         sha256             TEXT NOT NULL,
         created_at         BIGINT NOT NULL,
         expires_at         BIGINT NOT NULL,
         bound_command_id   TEXT,
         bound_request_hash TEXT,
         bound_session_id   TEXT,
         bound_at           BIGINT,
         UNIQUE (workspace_id,peon_id,transfer_id)
       )`,
      `CREATE INDEX IF NOT EXISTS attachment_transfer_receipts_expiry_idx
         ON attachment_transfer_receipts (expires_at)`,
      `CREATE INDEX IF NOT EXISTS attachment_transfer_receipts_command_idx
         ON attachment_transfer_receipts (workspace_id,peon_id,bound_command_id)`,
    ],
  },
  {
    // Email + password sign-in beside GitHub. NULL means "this account has no
    // password" — every GitHub-created user, and it is not an error state.
    id: "032_user_passwords",
    statements: [`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`],
  },
  {
    // Peon releases are distributed exclusively through the public npm
    // registry. Overseer no longer stores release metadata or archive bytes.
    id: "033_remove_peon_releases",
    statements: [`DROP TABLE IF EXISTS releases`],
  },
  {
    // Outbound peon-claim-v1 was retired before production rollout. Pairing is
    // now exclusively Overseer-initiated through a Peon's one-time phrase.
    id: "034_remove_peon_claim_v1",
    statements: [
      `DELETE FROM peons WHERE credential_id IN (SELECT id FROM peon_claim_credentials)`,
      `DROP TABLE IF EXISTS peon_claim_peon_revocations`,
      `DROP TABLE IF EXISTS peon_claim_ack_auth`,
      `DROP TABLE IF EXISTS peon_claim_audit`,
      `DROP TABLE IF EXISTS peon_claim_rate_limits`,
      `DROP TABLE IF EXISTS peon_claim_request_nonces`,
      `DROP TABLE IF EXISTS peon_credential_rotations`,
      `DROP TABLE IF EXISTS peon_claim_deliveries`,
      `DROP TABLE IF EXISTS peon_claim_credentials`,
      `DROP TABLE IF EXISTS peon_claim_attempts`,
      `DROP TABLE IF EXISTS peon_claim_resolutions`,
      `DROP TABLE IF EXISTS peon_claims`,
      `DROP TABLE IF EXISTS peon_enrollment_leases`,
      `DROP TABLE IF EXISTS peon_identity_bindings`,
    ],
  },
  {
    // Transcript history and recovery are served only by Peon's canonical
    // Fleet HTTP API. Live rows are transient WebSocket frames, so Overseer no
    // longer retains a second message-body projection or transcript event log.
    id: "035_remove_transcript_projection",
    statements: [
      `DELETE FROM events WHERE kind = 'transcript'`,
      `DROP TABLE IF EXISTS transcript_events`,
      `DROP TABLE IF EXISTS peon_transcript_sync`,
    ],
  },
];
