// Abuse control for dictation. Sign-up is open GitHub OAuth, so an
// authenticated user is not a trusted user — without a quota the instance key
// is a free public ASR service.
//
// Two limits, both per user and both rolling:
//   - a request rate, which stops a script hammering the route;
//   - an audio-seconds budget, which is what actually costs money, since a
//     single request may carry two minutes of audio.
//
// In memory, like the sign-in limiter in routes/auth.ts. One Overseer process
// holds the whole fleet today; a second instance would need this in Postgres,
// which is the same trade already recorded for the event fan-out.

export interface VoiceQuotaLimits {
  requestsPerMinute: number;
  audioSecondsPerHour: number;
}

export interface VoiceQuotaDecision {
  allowed: boolean;
  reason: "requests" | "audio-seconds" | null;
  retryAfterSeconds: number;
}

interface QuotaEntry {
  at: number;
  seconds: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

const usage = new Map<string, QuotaEntry[]>();

// Opus at the ~32 kbps the clients record is roughly 4 KB per second. Charging
// the larger of the declared duration and this estimate means a client cannot
// under-declare its way past the budget, while an honest client is charged
// what it actually sent.
const ESTIMATED_BYTES_PER_SECOND = 4_000;

export function estimateAudioSeconds(byteLength: number, declaredDurationMs: number | undefined): number {
  const declared = declaredDurationMs === undefined ? 0 : declaredDurationMs / 1_000;
  return Math.max(declared, byteLength / ESTIMATED_BYTES_PER_SECOND);
}

export function checkVoiceQuota(userId: string, chargedSeconds: number, limits: VoiceQuotaLimits, now = Date.now()): VoiceQuotaDecision {
  const entries = (usage.get(userId) ?? []).filter((entry) => entry.at > now - HOUR_MS);

  const recent = entries.filter((entry) => entry.at > now - MINUTE_MS);
  if (recent.length >= limits.requestsPerMinute) {
    usage.set(userId, entries);
    const oldest = recent[0]?.at ?? now;
    return { allowed: false, reason: "requests", retryAfterSeconds: Math.max(1, Math.ceil((oldest + MINUTE_MS - now) / 1_000)) };
  }

  const spentSeconds = entries.reduce((total, entry) => total + entry.seconds, 0);
  if (spentSeconds + chargedSeconds > limits.audioSecondsPerHour) {
    usage.set(userId, entries);
    const oldest = entries[0]?.at ?? now;
    return { allowed: false, reason: "audio-seconds", retryAfterSeconds: Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1_000)) };
  }

  // Only a request that is actually admitted is recorded — a rejected one must
  // not extend its own cool-off.
  entries.push({ at: now, seconds: chargedSeconds });
  usage.set(userId, entries);
  pruneIdleUsers(now);
  return { allowed: true, reason: null, retryAfterSeconds: 0 };
}

function pruneIdleUsers(now: number): void {
  if (usage.size < 512) return;
  for (const [userId, entries] of usage) {
    if (entries.every((entry) => entry.at <= now - HOUR_MS)) usage.delete(userId);
  }
}

// Tests drive the limiter directly; the process never needs this.
export function resetVoiceQuota(): void {
  usage.clear();
}
