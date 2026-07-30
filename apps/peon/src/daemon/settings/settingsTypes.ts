import type { CodingAgent, ReasoningEffort } from "../modelCatalog.js";

export type FleetMode = "legacy-mesh" | "reverse-only";

export interface DaemonSettings {
  updateCheckIntervalMs: number;
  maxTurns: number;
  taskTimeoutMs: number;
  paused: boolean;
  // Coding backend used when a session create request omits `agent`.
  defaultAgent: CodingAgent;
  agentCommand: string;
  // Codex CLI binary used when a session selects agent:"codex".
  codexCommand: string;
  // Per-session USD cap passed as `--max-budget-usd`. 0 (default) means no cap —
  // agentExecutor's `if (opts.maxBudgetUsd)` guard omits the flag entirely.
  maxBudgetUsd: number;
  // Externally-reachable base URLs used to build magic-link hrefs: the link itself points
  // at publicDashboardUrl (`/?token=...`), whose page reads the token and POSTs it to
  // publicControlUrl (`/api/v1/auth/consume`) to actually authenticate. Cookies are set with
  // no Domain attribute + sameSite:"lax", so these two must keep the same hostname
  // (differ only by port) for the cross-origin cookie flow to keep working — a
  // genuinely different hostname per side would need SameSite=None + Secure + an
  // explicit cookie Domain=, which isn't set up here.
  publicControlUrl: string;
  publicDashboardUrl: string;
  // Network interface the control API and dashboard bind to. "127.0.0.1"
  // (default) accepts loopback only — the CLI, scripts, and same-box browsers.
  // "0.0.0.0" (or a specific interface IP) accepts remote connections, which
  // then go through per-user magic-link auth (only loopback is auto-trusted as
  // admin). Read once at process startup — changing it needs a daemon +
  // dashboard restart. Env var ACA_BIND_HOST overrides it.
  bindHost: string;
  // Explicit transport policy. Existing installations inherit legacy-mesh,
  // preserving inbound Fleet HTTP until an operator opts into reverse-only.
  // reverse-only is fail-closed: the daemon/dashboard must bind loopback and
  // legacy registration/heartbeat and callback enrollment stay disabled.
  fleetMode: FleetMode;
  // Display name for this peon instance — shown in the dashboard tab title.
  // Empty means unset; the dashboard falls back to "Peon" in that case.
  name: string;
  // When true (default), eligible ad-hoc sessions killed mid-run by a daemon
  // restart are automatically resumed on the next startup, up to a per-session
  // attempt cap.
  autoResumeInterrupted: boolean;
  // Shared secret a "overseer" (fleet control plane) presents as
  // `Authorization: Bearer <token>` to reach this peon's machine-facing
  // fleet profile of `/api/v1/*` (src/daemon/agentApi.ts). Empty (default)
  // disables bearer-authenticated fleet requests, so a peon that isn't part of
  // a fleet exposes no additional capabilities. The token is trusted to assert
  // the acting human's identity via a `Peon-Actor` header (forwarded into a
  // session's `author`), so it must be treated as a full-admin credential and
  // only travels over the tailnet, never the public internet.
  overseerToken: string;
  // Filesystem root the fleet `/api/v1/files/*` endpoints are sandboxed to. Empty
  // (default) disables file transfer entirely (503 `FILES_DISABLED`) — the
  // endpoints exist but expose nothing until an operator opts in by pointing
  // this at a real directory. Every requested path is resolved against this
  // root and rejected if it escapes it, so widening it widens what the
  // overseer can read/write on this box.
  fileTransferRoot: string;
  // Base URL of the overseer this peon should announce itself to (e.g.
  // "http://overseer.my-tailnet.ts.net:5000"). Empty (default) means this peon
  // registers with nothing and stays a purely passive server — the overseer
  // must then be told about it out-of-band. When set (together with a
  // overseerToken, presented as this peon's bearer to the overseer — the
  // token is the symmetric shared secret for the pair), peonRegistrar POSTs a
  // registration on startup and a periodic heartbeat carrying live load, so the
  // registry self-populates and NAT boxes need no inbound reachability to be
  // discovered.
  overseerUrl: string;
  // Stable identity this peon reports to the overseer. Auto-generated (and
  // persisted here) on first registration if empty, so it survives restarts and
  // the overseer can dedupe a peon across reconnects rather than treating each
  // boot as a new machine.
  peonId: string;
  // How often peonRegistrar heartbeats the overseer once registered.
  heartbeatIntervalMs: number;
  // The armed one-time pairing phrase (an orcish string like "lok-tar-ogar-dabu")
  // that bootstraps recruitment — see src/daemon/pairing.ts and PROTOCOL.md
  // "Recruitment". Empty (default) means no pairing window is open. It authorizes
  // POST /api/v1/enroll (alongside the current overseerToken) so a never-recruited
  // peon, which holds no overseer credential yet, can still be handed one; it is
  // single-use (burned on a successful enroll) and TTL'd (pairingSecretExpiresAt).
  // Stored plaintext here like overseerToken, and redacted from the startup log —
  // it must never be logged after the one line printed when it's generated.
  pairingSecret: string;
  // Epoch ms after which pairingSecret stops being accepted by /enroll (0 = no
  // window open). Set to now + pairingTtlMs whenever a phrase is armed.
  pairingSecretExpiresAt: number;
  // How long an armed pairing phrase stays valid (default 15 min). A short window
  // is part of what keeps a memorable (lower-entropy) phrase safe.
  pairingTtlMs: number;
  // AI backend config. `defaultModel` is this peon's global default model
  // (`--model`) for any session that doesn't pick one itself — resolved live on
  // every spawn (perTurn ?? SessionRecord.model ?? this ?? CLI default), so
  // changing it applies to future turns of existing sessions too. Empty string
  // ⇒ no --model flag ⇒ whatever Claude Code is configured to use on the box.
  // The one nested (object-valued) setting: a container so provider-specific AI
  // config can join it later without churning the flat top level.
  ai: {
    defaultModel: string | null;
    // Applied only when the resolved model supports it. Null delegates to the
    // provider/model default.
    defaultReasoningEffort: ReasoningEffort | null;
    // Peon-wide soul injected into every agent turn, between
    // the fixed harness contract and project-specific context. Empty disables
    // the layer. Markdown is allowed so personality, voice, judgment, and
    // working style can be given useful shape.
    soul: string;
  };
}
