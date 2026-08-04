// All configuration comes from the environment. No shared peon secret and no
// operator key: peons connect with per-peon credentials (credentials.ts),
// operators with device tokens (auth.ts). peonCallbackUrl is the Tailscale URL the
// overseer hands a peon at recruitment so it knows where to phone home.
import { resolvePushConfig, type PushConfig } from "./infrastructure/push/pushConfig.js";
import { resolveVoiceConfig, type VoiceConfig } from "./infrastructure/voice/voiceConfig.js";

export interface Config {
  port: number;
  host: string;
  peonCallbackUrl: string;
  // Postgres connection string — the single system-of-record. Required to boot.
  databaseUrl: string;
  // How often the session index reconciles by pulling each online peon's
  // /sessions. A durable baseline independent of (later) event push.
  reconcileIntervalMs: number;

  // ---- operator/mobile auth (GitHub OAuth → device tokens) ----
  // Public base URL of the operator surface. The SPA's OAuth callback lives
  // here, so it must match how the app is actually reached.
  publicUrl: string;
  // GitHub OAuth app credentials (infrastructure/github). The SPA drives the redirect; the
  // server does the code→token exchange with the secret, never exposed to the client.
  githubClientId: string;
  githubClientSecret: string;
  githubScope: string;
  // The single frontend HTTPS callback registered with GitHub. Both web and
  // native starts use it; the SPA submits code + state to the API, where
  // server-backed state decides which client receives the result.
  githubRedirectUri: string;
  githubNativeCallbacks: string[];
  // Email + password sign-in beside GitHub, off unless an operator asks for it.
  // Registration and sign-in share the switch: an instance that does not want
  // local accounts must not accept new ones either.
  passwordAuthEnabled: boolean;
  // How long an issued device token lives.
  deviceTokenTtlMs: number;
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

const publicUrl = (process.env.OVERSEER_PUBLIC_URL ?? "https://overseer.rnm.dev").replace(/\/+$/, "");

export const config: Config = {
  port: num("OVERSEER_PORT", 5000),
  // Bind 0.0.0.0 on the Tailscale-connected host so interface startup order
  // cannot strand the listener;
  // defaults to loopback so a misconfigured deploy doesn't expose the operator API.
  host: process.env.OVERSEER_HOST ?? "127.0.0.1",
  peonCallbackUrl: (process.env.OVERSEER_PEON_CALLBACK_URL ?? "").replace(/\/+$/, ""),
  databaseUrl: process.env.DATABASE_URL ?? process.env.OVERSEER_DATABASE_URL ?? "",
  reconcileIntervalMs: num("OVERSEER_RECONCILE_INTERVAL_MS", 30_000),
  publicUrl,
  githubClientId: process.env.OVERSEER_GITHUB_CLIENT_ID ?? "",
  githubClientSecret: process.env.OVERSEER_GITHUB_CLIENT_SECRET ?? "",
  githubScope: process.env.OVERSEER_GITHUB_SCOPE ?? "read:user user:email",
  githubRedirectUri: process.env.OVERSEER_GITHUB_REDIRECT_URI ?? `${publicUrl}/auth/github/callback`,
  githubNativeCallbacks: (process.env.OVERSEER_GITHUB_NATIVE_CALLBACKS ?? "overseer://oauth/github")
    .split(",").map((value) => value.trim()).filter(Boolean),
  passwordAuthEnabled: process.env.OVERSEER_PASSWORD_AUTH === "1",
  deviceTokenTtlMs: num("OVERSEER_DEVICE_TOKEN_TTL_MS", 90 * 24 * 60 * 60_000),
  trustedProxies: csv("OVERSEER_TRUSTED_PROXIES"),
  previewDomain: (process.env.OVERSEER_PREVIEW_DOMAIN ?? "preview.overseer.rnm.dev").toLowerCase().replace(/^\.+|\.+$/g, ""),
  previewTokenTtlMs: num("OVERSEER_PREVIEW_TOKEN_TTL_MS", 10 * 60_000),
  voice: resolveVoiceConfig(process.env),
  push: resolvePushConfig(process.env),
};

// Surfaced at startup so a deploy with no secrets set fails loud rather than
// silently accepting anyone.
export function configWarnings(): string[] {
  const w: string[] = [];
  if (!config.peonCallbackUrl)
    w.push("OVERSEER_PEON_CALLBACK_URL is empty — Peon enrollment is disabled.");
  if (!config.githubClientId || !config.githubClientSecret)
    w.push("OVERSEER_GITHUB_CLIENT_ID / OVERSEER_GITHUB_CLIENT_SECRET are not both set — GitHub sign-in is disabled, so nobody can log in.");
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
