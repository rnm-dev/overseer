import { createSign } from "node:crypto";
import type { FcmServiceAccount } from "./pushConfig.js";

// FCM HTTP v1 in the same spirit as the rest of the infrastructure: one small
// adapter, no SDK. Google's own client library exists to do exactly two things
// here — sign a JWT with the service account key and exchange it for an access
// token — and both are a handful of lines against node:crypto and fetch, so the
// dependency (and its transitive tree) buys nothing.
//
// v1, not the retired legacy server key, because a service account is what
// Firebase issues today and the per-message error codes are what let a dead
// token be retired instead of retried forever.

const SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_LIFETIME_MS = 3600_000;
// Refresh a minute early: a token that expires mid-flight costs a whole
// delivery pass, and a minute of a one-hour lifetime is free.
const TOKEN_SKEW_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface PushMessage {
  title: string;
  body: string;
  data: Record<string, unknown>;
}

export class PushDeliveryError extends Error {
  // A permanent failure is about this token, not this attempt: the device
  // uninstalled, or the token belongs to another Firebase project. Retrying it
  // can only fail again, so the subscription is retired instead.
  constructor(message: string, readonly permanent: boolean) {
    super(message);
    this.name = "PushDeliveryError";
  }
}

export interface LiveActivityDelivery {
  /**
   * The app instance's ordinary FCM registration token. FCM v1 requires a
   * recipient on every message — `token`, `topic` or `condition` — and an
   * ActivityKit token is not one of them: a message carrying only
   * `apns.live_activity_token` is refused with 400 "Recipient of the message is
   * not set". It names the app instance; the activity token below is what the
   * push is actually delivered to.
   */
  registrationToken: string;
  /** ActivityKit's push-to-start or per-activity update token — never an FCM token. */
  activityToken: string;
  /** The `aps` envelope built by infrastructure/push/liveActivity.ts. */
  payload: Record<string, unknown>;
  /** `<bundleId>.push-type.liveactivity`, when the client told us its bundle. */
  topic: string | null;
}

export interface PushSender {
  send(token: string, message: PushMessage): Promise<void>;
  sendLiveActivity(delivery: LiveActivityDelivery): Promise<void>;
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signedJwt(account: FcmServiceAccount, nowMs: number): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(JSON.stringify({
    iss: account.clientEmail,
    scope: SCOPE,
    aud: account.tokenUri,
    iat,
    exp: iat + TOKEN_LIFETIME_MS / 1000,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  signer.end();
  return `${header}.${claims}.${signer.sign(account.privateKey).toString("base64url")}`;
}

// FCM data payloads are string→string; anything else is rejected by the API.
// Nullish members are dropped rather than sent as "null", so a client reading
// `data.sessionId` sees an absent key for a Peon-level event.
function stringData(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

async function errorDetail(response: Response): Promise<{ message: string; status: string }> {
  const body = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; status?: unknown; details?: Array<{ errorCode?: unknown }> } };
    const errorCode = parsed.error?.details?.find((d) => typeof d?.errorCode === "string");
    return {
      message: typeof parsed.error?.message === "string" ? parsed.error.message : body.slice(0, 200),
      status: String(errorCode?.errorCode ?? parsed.error?.status ?? ""),
    };
  } catch {
    return { message: body.slice(0, 200).replace(/\s+/g, " ").trim(), status: "" };
  }
}

// A token is dead when FCM says so (UNREGISTERED / NOT_FOUND) or when it never
// belonged here (INVALID_ARGUMENT on a send whose only variable is the token).
// Everything else — quota, auth, upstream trouble — is worth another pass.
function isPermanent(httpStatus: number, code: string): boolean {
  if (code === "UNREGISTERED" || code === "NOT_FOUND" || code === "INVALID_ARGUMENT") return true;
  return httpStatus === 404 || httpStatus === 400;
}

export function createFcmSender(account: FcmServiceAccount, now: () => number = Date.now): PushSender {
  const endpoint = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`;
  let cached: { token: string; expiresAt: number } | null = null;
  let inFlight: Promise<string> | null = null;

  async function requestAccessToken(): Promise<string> {
    const issuedAt = now();
    const response = await fetch(account.tokenUri, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: signedJwt(account, issuedAt),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new PushDeliveryError(`FCM token exchange responded ${response.status}${detail.message ? `: ${detail.message}` : ""}`, false);
    }
    const payload = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof payload.access_token !== "string" || !payload.access_token) {
      throw new PushDeliveryError("FCM token exchange returned no access_token", false);
    }
    const lifetimeMs = typeof payload.expires_in === "number" ? payload.expires_in * 1000 : TOKEN_LIFETIME_MS;
    cached = { token: payload.access_token, expiresAt: issuedAt + lifetimeMs - TOKEN_SKEW_MS };
    return payload.access_token;
  }

  // One exchange at a time: a delivery pass sends up to a hundred messages, and
  // without this every one of them would mint its own token on a cold start.
  async function accessToken(): Promise<string> {
    if (cached && cached.expiresAt > now()) return cached.token;
    if (!inFlight) inFlight = requestAccessToken().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function post(message: Record<string, unknown>): Promise<Response> {
    return fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  async function deliver(message: Record<string, unknown>): Promise<void> {
    let response = await post(message);
    // An unauthorized answer is worth exactly one free retry with a fresh
    // token: a cached token Google revoked early would otherwise wedge every
    // delivery until the process restarts.
    if (response.status === 401 && cached) {
      cached = null;
      response = await post(message);
    }
    if (response.ok) return;
    const detail = await errorDetail(response);
    throw new PushDeliveryError(
      `FCM responded ${response.status}${detail.message ? `: ${detail.message}` : ""}`,
      isPermanent(response.status, detail.status),
    );
  }

  return {
    async send(token: string, message: PushMessage): Promise<void> {
      await deliver({
        token,
        notification: { title: message.title, body: message.body },
        data: stringData(message.data),
        android: { priority: "HIGH", notification: { sound: "default" } },
        apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default" } } },
      });
    },

    // A Live Activity is addressed twice over: `apns.live_activity_token` is
    // where it is delivered, and the message's own `token` is the app instance
    // FCM routes through. Both are required — verified against
    // `messages:send?validate_only`, which refuses the activity token on its own
    // with "Recipient of the message is not set" — so a device with no ordinary
    // FCM registration cannot be sent a Live Activity at all.
    async sendLiveActivity(delivery: LiveActivityDelivery): Promise<void> {
      const headers: Record<string, string> = { "apns-push-type": "liveactivity", "apns-priority": "10" };
      if (delivery.topic) headers["apns-topic"] = delivery.topic;
      await deliver({
        token: delivery.registrationToken,
        apns: { liveActivityToken: delivery.activityToken, headers, payload: delivery.payload },
      });
    },
  };
}
