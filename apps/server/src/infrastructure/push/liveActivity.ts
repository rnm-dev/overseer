// The ActivityKit half of the push infrastructure: the APNs payload that starts,
// updates and ends a Live Activity. Pure — it builds a JSON object and nothing
// else — so the encoding Apple demands can be asserted without a network, a
// credential, or a database.
//
// Two encodings have to be right or the phone silently drops the push, so both
// are spelled out here rather than at the call site:
//
//   `aps.timestamp` / `stale-date` / `dismissal-date` are **UNIX seconds** —
//   APNs reads them itself.
//
//   Every `Date` *inside* `content-state` is **seconds since Apple's reference
//   date** (2001-01-01), because ActivityKit decodes the content state with a
//   stock `JSONDecoder`, whose default strategy for `Date` is
//   `timeIntervalSinceReferenceDate`. Sending UNIX seconds here does not fail
//   loudly: it renders a date 31 years in the future.

// The Swift type name the iOS client declares. APNs matches the payload to the
// app's ActivityAttributes by this string; a mismatch is a silent no-op.
export const ATTRIBUTES_TYPE = "OverseerSessionAttributes";

// 2001-01-01T00:00:00Z in UNIX ms — the origin of Swift's `Date`.
export const APPLE_REFERENCE_EPOCH_MS = 978_307_200_000;

// The mobile client dismisses a finished activity 90 seconds after it ends; the
// end push carries the same deadline so the activity also disappears on its own
// if the app never runs again.
export const TERMINAL_DISMISSAL_MS = 90_000;

// How long the phone may show the aggregate without hearing from us before it
// greys the content out. Updates are sent only when the counts actually move
// (see liveActivity.ts), so a long-running session can legitimately go hours
// without one — a short stale window would grey out a perfectly live activity.
export const STALE_AFTER_MS = 8 * 60 * 60_000;

export type LiveActivityEvent = "start" | "update" | "end";

export interface LiveActivityContentState {
  runningCount: number;
  completedCount: number;
  /** Epoch ms — earliest start among the owned running sessions. */
  oldestStartedAt: number | null;
  /** Epoch ms — latest authoritative session activity. */
  updatedAt: number;
}

export interface LiveActivityAttributes {
  activityId: string;
  connectionId: string;
}

export interface LiveActivityAlert {
  title: string;
  body: string;
}

function unixSeconds(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Epoch ms → the `Double` a stock Swift `JSONDecoder` reads back as a `Date`. */
export function appleDate(ms: number | null): number | null {
  return ms === null ? null : (ms - APPLE_REFERENCE_EPOCH_MS) / 1000;
}

function contentState(state: LiveActivityContentState): Record<string, unknown> {
  return {
    runningCount: state.runningCount,
    completedCount: state.completedCount,
    // Explicit null rather than an absent key: the synthesized decoder for an
    // optional Date accepts both, and null says "no running session" out loud.
    oldestStartedAt: appleDate(state.oldestStartedAt),
    updatedAt: appleDate(state.updatedAt),
  };
}

// Apple requires a visible alert on a push-to-start, and only on that one: a
// start wakes a terminated app, so the system insists the user be told. An
// update carrying an alert would buzz the phone on every count change.
export function startAlert(runningCount: number): LiveActivityAlert {
  return runningCount === 1
    ? { title: "Session running", body: "Your run is in progress" }
    : { title: "Sessions running", body: `${runningCount} runs in progress` };
}

export function liveActivityPayload(input: {
  event: LiveActivityEvent;
  now: number;
  state: LiveActivityContentState;
  attributes?: LiveActivityAttributes;
  alert?: LiveActivityAlert;
}): Record<string, unknown> {
  const aps: Record<string, unknown> = {
    timestamp: unixSeconds(input.now),
    event: input.event,
    "content-state": contentState(input.state),
  };
  if (input.event === "start") {
    // The identity is the *connection*, never a session: one aggregate per
    // operator per device, whatever it is currently counting.
    aps["attributes-type"] = ATTRIBUTES_TYPE;
    aps.attributes = input.attributes ?? {};
  }
  if (input.alert) aps.alert = { ...input.alert, sound: "default" };
  if (input.event === "end") aps["dismissal-date"] = unixSeconds(input.now + TERMINAL_DISMISSAL_MS);
  else aps["stale-date"] = unixSeconds(input.now + STALE_AFTER_MS);
  return { aps };
}

// APNs routes a Live Activity by a topic suffixed with the push type, not by the
// plain bundle ID. Without it a project holding two iOS apps cannot tell which
// one a token belongs to.
export function liveActivityTopic(bundleId: string | null): string | null {
  const trimmed = (bundleId ?? "").trim();
  return trimmed ? `${trimmed}.push-type.liveactivity` : null;
}
