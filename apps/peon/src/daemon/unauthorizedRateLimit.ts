const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

interface FailureWindow {
  startedAt: number;
  count: number;
}

export interface UnauthorizedRateLimitDecision {
  limited: boolean;
  retryAfterSeconds: number;
}

export interface UnauthorizedRateLimiterOptions {
  windowMs?: number;
  maxFailures?: number;
  maxSources?: number;
  now?: () => number;
}

/**
 * Bounds repeated authentication failures per remote socket address. Successful
 * requests never call this limiter, and genuine loopback failures are exempt.
 */
export class UnauthorizedRateLimiter {
  private readonly failures = new Map<string, FailureWindow>();
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly maxSources: number;
  private readonly now: () => number;

  constructor(options: UnauthorizedRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxFailures = options.maxFailures ?? 20;
    this.maxSources = options.maxSources ?? 2_048;
    this.now = options.now ?? Date.now;
  }

  recordFailure(address: string | undefined): UnauthorizedRateLimitDecision {
    if (address && LOOPBACK_ADDRESSES.has(address)) {
      return { limited: false, retryAfterSeconds: 0 };
    }

    const source = address || "unknown";
    const now = this.now();
    let window = this.failures.get(source);
    if (!window || now - window.startedAt >= this.windowMs) {
      if (!window && this.failures.size >= this.maxSources) this.prune(now);
      if (!window && this.failures.size >= this.maxSources) {
        return { limited: true, retryAfterSeconds: Math.ceil(this.windowMs / 1_000) };
      }
      window = { startedAt: now, count: 0 };
      this.failures.set(source, window);
    }

    window.count += 1;
    return {
      limited: window.count > this.maxFailures,
      retryAfterSeconds: Math.max(1, Math.ceil((window.startedAt + this.windowMs - now) / 1_000)),
    };
  }

  private prune(now: number): void {
    for (const [source, window] of this.failures) {
      if (now - window.startedAt >= this.windowMs) this.failures.delete(source);
    }
  }
}
