// All configuration comes from the environment. No shared peon secret and no
// operator key: peons connect with per-peon credentials (credentials.ts),
// operators with device tokens (auth.ts).
//
// Two variables are required — DATABASE_URL and OVERSEER_PUBLIC_URL — and
// everything else has a default that produces a working instance. A knob exists
// here only when a deployment genuinely decides it; values that are merely
// tuned live as constants next to the code that uses them, so the surface an
// operator has to read is the surface that matters. The full list, with
// defaults, is docs/configuration.md.
import { resolveAuthConfig, type AuthConfig } from "../auth/authConfig.js";
import { resolvePushConfig, type PushConfig } from "../push/pushConfig.js";
import { resolveVoiceConfig, type VoiceConfig } from "../voice/voiceConfig.js";

export interface Config {
  port: number;
  host: string;
  // Where a peon is told to phone home. Defaults to publicUrl: an instance that
  // can be reached by an operator can be reached by a peon, and enrollment is
  // not an opt-in half of the product. It is separate only for the deployment
  // whose peons arrive over a different name than the browser does — a
  // Tailscale address against a public domain.
  peonCallbackUrl: string;
  // Postgres connection string — the single system-of-record. Required to boot.
  databaseUrl: string;
  // How often the session index reconciles by pulling each online peon's
  // /sessions. A durable baseline independent of (later) event push.
  reconcileIntervalMs: number;

  // ---- operator/mobile auth (a sign-in method → device tokens) ----
  // Public base URL of the operator surface. The SPA's OAuth callback lives
  // here, so it must match how the app is actually reached.
  publicUrl: string;
  // The sign-in methods this instance has — GitHub OAuth and email + password —
  // each configured or absent, resolved beside their guards in
  // infrastructure/auth so availability is decided in exactly one place.
  auth: AuthConfig;
  // Addresses/CIDRs of reverse proxies that may contribute
  // X-Forwarded-For. Empty means forwarded addresses are ignored.
  trustedProxies: string[];

  // Isolated HTML artifact previews are served from a sibling wildcard domain.
  // Each iframe gets an opaque, short-lived subdomain token; no Peon connection
  // details or credentials are encoded in the public URL.
  previewDomain: string;
  previewTokenTtlMs: number;

  // Voice dictation. The resolution rules (presets, per-stage overrides, which
  // stage counts as configured) live with the provider seam in
  // infrastructure/voice; this is only the wiring, so the two never depend on
  // each other in a cycle.
  voice: VoiceConfig;

  // Push notifications. Expo needs no credential; FCM is enabled by a Firebase
  // service account, resolved next to its sender in infrastructure/push.
  push: PushConfig;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function csv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

// Our own origin, kept as the development convenience it has always been. In
// production it is not a default anyone should inherit: every URL an operator
// or a peon is handed derives from this, so an instance that forgets it would
// quietly send its own people to somebody else's host. configErrors() refuses
// that boot rather than leaving it to be discovered from a callback.
const DEV_PUBLIC_URL = "https://overseer.rnm.dev";
const publicUrlFromEnv = (process.env.OVERSEER_PUBLIC_URL ?? "").trim();
const publicUrl = (publicUrlFromEnv || DEV_PUBLIC_URL).replace(/\/+$/, "");

export const config: Config = {
  port: num("OVERSEER_PORT", 5000),
  // Every supported deployment runs the app in a container behind a reverse
  // proxy, where a loopback default binds to nothing reachable and the listener
  // simply looks dead. Publishing the port is the proxy's decision, not this
  // one's.
  host: process.env.OVERSEER_HOST ?? "0.0.0.0",
  peonCallbackUrl: ((process.env.OVERSEER_PEON_CALLBACK_URL ?? "").trim() || publicUrl).replace(/\/+$/, ""),
  databaseUrl: process.env.DATABASE_URL ?? "",
  reconcileIntervalMs: num("OVERSEER_RECONCILE_INTERVAL_MS", 30_000),
  publicUrl,
  auth: resolveAuthConfig(process.env, publicUrl),
  trustedProxies: csv("OVERSEER_TRUSTED_PROXIES"),
  previewDomain: (process.env.OVERSEER_PREVIEW_DOMAIN ?? "preview.overseer.rnm.dev").toLowerCase().replace(/^\.+|\.+$/g, ""),
  previewTokenTtlMs: num("OVERSEER_PREVIEW_TOKEN_TTL_MS", 10 * 60_000),
  voice: resolveVoiceConfig(process.env),
  push: resolvePushConfig(process.env),
};

/**
 * Misconfiguration that must stop the boot, as opposed to the warnings below.
 *
 * The bar is narrow on purpose: a value is an error only when continuing would
 * point this instance's own operators and peons at an origin that is not
 * theirs. Everything else — a missing door, no voice provider, an unreadable
 * push credential — is a valid if reduced deployment and only warns.
 */
export function configErrors(): string[] {
  const e: string[] = [];
  if (process.env.NODE_ENV === "production" && !publicUrlFromEnv)
    e.push(`OVERSEER_PUBLIC_URL is not set — it would fall back to ${DEV_PUBLIC_URL}, and every operator callback and peon enrollment URL derives from it. Set it to this instance's own public origin.`);
  if (!config.databaseUrl)
    e.push("DATABASE_URL is not set — Overseer has no meaningful degraded mode without its system-of-record.");
  return e;
}

// Surfaced at startup so a deploy with no secrets set fails loud rather than
// silently accepting anyone.
export function configWarnings(): string[] {
  const w: string[] = [];
  // Which doors exist, and any half-configured one, is decided by the auth
  // resolver; this only reports what it found.
  w.push(...config.auth.warnings);
  if (process.env.NODE_ENV === "production" && config.trustedProxies.length === 0)
    w.push("OVERSEER_TRUSTED_PROXIES is empty — forwarded client addresses are ignored and public abuse limits use the socket peer.");
  // An unconfigured or half-configured voice stage is a boot-time warning, not
  // a request-time failure: clients read /api/v1/voice/capabilities and simply
  // hide the mic button on an instance with no provider.
  if (!config.voice.stt)
    w.push("OVERSEER_VOICE / OVERSEER_VOICE_STT_BASE_URL are not set — voice dictation is disabled.");
  w.push(...config.voice.warnings);
  // A misread credential is a warning, not a boot failure: Expo delivery is
  // unaffected, and an instance whose mobile clients don't use FCM is a valid
  // deployment rather than a broken one.
  w.push(...config.push.warnings);
  return w;
}
