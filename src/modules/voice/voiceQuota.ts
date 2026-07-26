// Abuse control for dictation. Sign-up is open GitHub OAuth, so an
// authenticated user is not a trusted user — without a quota the instance key
// is a free public ASR service.
//
// Three rolling limits. Two are per user:
//   - a request rate, which stops a script hammering the route;
//   - an audio-seconds budget, which is what actually costs money, since a
//     single request may carry two minutes of audio.
// The third is per instance: a daily request ceiling matching whatever the
// provider actually grants, so one busy user cannot spend the fleet's whole
// day and leave everyone else looking at errors.
//
// In memory, like the sign-in limiter in routes/auth.ts. One Overseer process
// holds the whole fleet today; a second instance would need this in Postgres,
// which is the same trade already recorded for the event fan-out.

export interface VoiceQuotaLimits {
  requestsPerMinute: number;
  audioSecondsPerHour: number;
  // Shared across every user on the instance, because the provider budget is.
  // 0 means unconfigured — the operator has not told us their provider tier, so
  // we do not invent one.
  requestsPerDay: number;
}

export interface VoiceQuotaDecision {
  allowed: boolean;
  reason: "requests" | "audio-seconds" | "instance-day" | null;
  retryAfterSeconds: number;
}

interface QuotaEntry {
  at: number;
  seconds: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const usage = new Map<string, QuotaEntry[]>();
// The instance-wide ledger. The per-user limits stop one person being abusive;
// this stops one person — however legitimately — spending the whole fleet's
// provider budget for the day. On a free provider tier those are very different
// numbers: 20 requests/minute is 1200 an hour, against a daily ceiling that can
// be smaller than that.
let instanceUsage: number[] = [];

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
  // The instance ledger is checked first: if the shared budget is gone, no
  // per-user allowance can conjure more of it, and the caller deserves the
  // retry window that actually applies.
  instanceUsage = instanceUsage.filter((at) => at > now - DAY_MS);
  if (limits.requestsPerDay > 0 && instanceUsage.length >= limits.requestsPerDay) {
    const oldest = instanceUsage[0] ?? now;
    return { allowed: false, reason: "instance-day", retryAfterSeconds: Math.max(1, Math.ceil((oldest + DAY_MS - now) / 1_000)) };
  }

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
  // not extend its own cool-off. Both ledgers move together, so the shared
  // budget is never charged for a request the user was refused.
  entries.push({ at: now, seconds: chargedSeconds });
  usage.set(userId, entries);
  instanceUsage.push(now);
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
  instanceUsage = [];
}
