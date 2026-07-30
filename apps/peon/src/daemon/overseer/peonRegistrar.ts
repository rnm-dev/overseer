import os from "node:os";
import { settings, type PeonRegistrarSettings } from "../settings/index.js";
import { sessions } from "../sessions/index.js";
import { PROTOCOL_VERSION } from "../protocol.js";
import { ensurePeonId } from "../peonIdentity.js";
import { peonPublicUrl } from "../peonAddress.js";
import { peonClaimClient } from "../enrollment/index.js";

// The outbound half of the overseer protocol: this peon announcing *itself* to
// a central overseer (fleet control plane), so the registry self-populates and
// a NAT'd box (no inbound reachability) is still discoverable. It is the mirror
// image of agentApi.ts — that file is the inbound door the overseer calls;
// this is the peon reaching out. Uses a recursive setTimeout
// that re-reads settings every cycle, so enabling/disabling via `PATCH
// /api/v1/settings` takes effect on the next tick with no restart.
//
// Auth is symmetric: the same shared secret (settings.overseerToken) the
// overseer presents to command this peon is what this peon presents as its
// own bearer to register — one secret per peon<->overseer pair.

const CONTROL_PORT = Number(process.env.ACA_CONTROL_PORT ?? 4570);
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const CREDENTIAL_VERDICTS = new Set([
  "CREDENTIAL_INVALID",
  "CREDENTIAL_REVOKED",
  "CREDENTIAL_RETIRED",
]);

interface RegistrarState {
  enabled: boolean;
  registered: boolean;
  // Set while the overseer is rejecting the credential. A 401 is not definitive
  // proof of revocation: a recovering proxy or credential store can briefly
  // answer from stale state. Keep retrying with bounded backoff so the link can
  // recover without re-enrollment.
  derecruited: boolean;
  lastRegisteredAt: number | null;
  lastHeartbeatAt: number | null;
  lastError: string | null;
}

interface PeonRegistrarOptions {
  readSettings?: () => PeonRegistrarSettings;
  subscribe?: (listener: () => void) => () => void;
}

// Carries the HTTP status of a non-ok north-bound response so tick() can branch
// (401 de-recruit vs 404 re-register vs transient) without string-matching.
export class NorthError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const defaultReadSettings = () => settings.getPeonRegistrarSettings();
const defaultSubscribe = (listener: () => void): (() => void) => {
  settings.on("change", listener);
  return () => settings.off("change", listener);
};

function capabilities(fileTransferRoot: string): string[] {
  const caps = ["sessions", "session-pagination-v1", "transcript-pagination-v1", "control", "sse"];
  if (fileTransferRoot.trim()) caps.push("files");
  return caps;
}

export interface PeonRegistrar {
  start(): void;
  stop(): void;
  getState(): RegistrarState & { publicUrl: string | null; mode: PeonRegistrarSettings["fleetMode"] };
}

async function readBoundedErrorBody(response: Response): Promise<string | null> {
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ERROR_BODY_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_ERROR_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export async function northError(operation: string, response: Response): Promise<NorthError> {
  let stableCode = "";
  try {
    const raw = await readBoundedErrorBody(response);
    if (raw) {
      try {
        const body = JSON.parse(raw) as { code?: unknown };
        const code = typeof body.code === "string" ? body.code : "";
        if (CREDENTIAL_VERDICTS.has(code)) stableCode = code;
      } catch {
        // Bodies are never copied into state or logs.
      }
    }
  } catch {
    // Reading an error body is best-effort; status alone is still meaningful.
  }
  return new NorthError(response.status, stableCode, `${operation} -> ${response.status}`);
}

async function post(base: string, token: string, pathname: string, body: unknown): Promise<Response> {
  return fetch(`${base.replace(/\/$/, "")}${pathname}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "Peon-Protocol": String(PROTOCOL_VERSION),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
}

export function registrationPayload(peonId: string, settingsSource: PeonRegistrarSettings = defaultReadSettings()) {
  return {
    peonId,
    name: settingsSource.name || os.hostname(),
    hostname: os.hostname(),
    controlPort: CONTROL_PORT,
    // Canonical, operator-configured callback address. hostname/controlPort
    // remain as legacy direct-connect hints, but an overseer must not replace
    // this domain with the registration request's source IP.
    publicUrl: peonPublicUrl(),
    protocol: PROTOCOL_VERSION,
    capabilities: capabilities(settingsSource.fileTransferRoot),
    activeSessions: sessions.activeCount(),
    paused: settingsSource.paused,
    uptimeSec: Math.floor(process.uptime()),
  };
}

export function createPeonRegistrar(options: PeonRegistrarOptions = {}): PeonRegistrar {
  const readSettings = options.readSettings ?? defaultReadSettings;
  const subscribe = options.subscribe ?? defaultSubscribe;
  const state: RegistrarState = {
    enabled: false,
    registered: false,
    derecruited: false,
    lastRegisteredAt: null,
    lastHeartbeatAt: null,
    lastError: null,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Throttle identical connect errors to one log line — a overseer that's down
  // would otherwise spam the daemon log every heartbeat interval.
  let lastLoggedError: string | null = null;
  // The overseer (url, token) seen on the last tick — a change means a fresh
  // /enroll or manual re-point, which resets registration and auth backoff.
  let lastCreds = "";
  let consecutiveAuthFailures = 0;
  // Reentrancy + coalescing: the scheduled loop and the settings-change kick can
  // both call tick(). `ticking` serializes them; `kickRequested` makes a call that
  // arrives mid-tick run one more tick right after (so an /enroll landing during an
  // in-flight tick still re-registers immediately, not a whole interval later).
  let ticking = false;
  let kickRequested = false;

  async function register(base: string, token: string, peonId: string): Promise<void> {
    const res = await post(base, token, "/api/v1/peons/register", registrationPayload(peonId, readSettings()));
    if (!res.ok) throw await northError("register", res);
    state.registered = true;
    state.lastRegisteredAt = Date.now();
  }

  // Returns false when the overseer no longer knows this peon (404) — it likely
  // restarted and lost its registry, so the next tick re-registers rather than
  // heartbeating into the void.
  async function heartbeat(base: string, token: string, peonId: string): Promise<boolean> {
    const current = readSettings();
    const res = await post(base, token, `/api/v1/peons/${encodeURIComponent(peonId)}/heartbeat`, {
      activeSessions: sessions.activeCount(),
      paused: current.paused,
      uptimeSec: Math.floor(process.uptime()),
    });
    if (res.status === 404) return false;
    if (!res.ok) throw await northError("heartbeat", res);
    state.lastHeartbeatAt = Date.now();
    return true;
  }

  async function tick(): Promise<void> {
    if (ticking) {
      // A tick is already in flight (e.g. awaiting the network). Remember that
      // another was asked for so we run once more when this one finishes — this is
      // what makes an /enroll landing mid-tick re-register immediately.
      kickRequested = true;
      return;
    }
    ticking = true;
    try {
      const s = readSettings();
      if (s.fleetMode === "reverse-only") {
        state.enabled = false;
        state.registered = false;
        state.derecruited = false;
        state.lastError = null;
        return;
      }
      const base = s.overseerUrl.trim();
      const token = s.overseerToken.trim();
      state.enabled = Boolean(base && token);

      if (!state.enabled) {
        // Disabled (or just switched off) — forget any prior registration so
        // re-enabling starts clean.
        state.registered = false;
        return;
      }

      const creds = `${base}\n${token}`;
      if (creds !== lastCreds) {
        // Creds changed since last tick — a fresh /enroll or a manual re-point.
        // Start clean: forget any prior registration and lift a de-recruit stop,
        // since the revoked credential is no longer the one we hold.
        lastCreds = creds;
        state.registered = false;
        state.derecruited = false;
        consecutiveAuthFailures = 0;
      }

      const peonId = ensurePeonId();
      try {
        if (!state.registered) {
          await register(base, token, peonId);
          console.log(`overseer: registered with ${base} as ${peonId}`);
        } else if (!(await heartbeat(base, token, peonId))) {
          state.registered = false; // overseer forgot us — re-register next tick
        }
        state.derecruited = false;
        consecutiveAuthFailures = 0;
        state.lastError = null;
        lastLoggedError = null;
      } catch (err) {
        state.registered = false;
        if (err instanceof NorthError && err.status === 401) {
          // Only an explicit stable revocation verdict is authoritative enough
          // to erase the locally active credential. A bare/stale 401 keeps the
          // established bounded retry behavior.
          if (["CREDENTIAL_REVOKED", "CREDENTIAL_INVALID", "CREDENTIAL_RETIRED"].includes(err.code)) {
            peonClaimClient.recordCredentialRejection(token, err.code);
          }
          // One 401 is not enough to prove a durable revocation. A recovering
          // deployment can briefly authenticate against stale or unavailable
          // credential state. Mark the degraded state, but keep probing with
          // increasing delay so valid credentials self-heal without re-pairing.
          const firstAuthFailure = !state.derecruited;
          state.derecruited = true;
          consecutiveAuthFailures += 1;
          state.lastError = "credential rejected (401); retrying";
          if (firstAuthFailure) {
            console.warn("overseer: credential rejected (401) — will retry with backoff");
          }
          return;
        }
        state.lastError = err instanceof Error ? err.message : String(err);
        if (state.lastError !== lastLoggedError) {
          console.warn(`overseer: registration/heartbeat failed (${state.lastError}) — will keep retrying`);
          lastLoggedError = state.lastError;
        }
      }
    } finally {
      ticking = false;
      if (kickRequested) {
        kickRequested = false;
        void tick();
      }
    }
  }

  function schedule(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const baseDelay = Math.max(1_000, readSettings().heartbeatIntervalMs);
    const delay = consecutiveAuthFailures > 0
      ? Math.min(5 * 60_000, baseDelay * (2 ** Math.min(consecutiveAuthFailures - 1, 10)))
      : baseDelay;
    timer = setTimeout(async () => {
      await tick();
      schedule();
    }, delay);
  }

  return {
    // Fire one tick immediately (so a configured peon registers at startup rather
    // than after the first interval), then keep the heartbeat loop running.
    start(): void {
      stopped = false;
      // A fresh /enroll (or a manual re-point) rewrites overseerUrl/overseerToken.
      // tick() itself notices the cred change and re-registers, but that would only
      // happen on the next heartbeat interval — fire one now so recruitment is
      // effectively instant. Guarded on an actual cred change so unrelated settings
      // edits don't provoke extra heartbeats.
      subscribe(() => {
        const latest = readSettings();
        if (`${latest.overseerUrl.trim()}\n${latest.overseerToken.trim()}` !== lastCreds) void tick();
      });
      void tick().then(schedule);
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },

    getState(): RegistrarState & { publicUrl: string | null; mode: PeonRegistrarSettings["fleetMode"] } {
      const mode = readSettings().fleetMode;
      return { ...state, mode, publicUrl: mode === "reverse-only" ? null : peonPublicUrl() };
    },
  };
}

export const peonRegistrar = createPeonRegistrar();
