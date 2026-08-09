import assert from "node:assert/strict";
import test from "node:test";
import { UnauthorizedRateLimiter } from "../runtime/unauthorizedRateLimit.js";

test("only failed remote authorization attempts consume the bounded window", () => {
  let now = 1_000;
  const limiter = new UnauthorizedRateLimiter({
    maxFailures: 2,
    windowMs: 10_000,
    now: () => now,
  });

  assert.equal(limiter.recordFailure("100.64.0.7").limited, false);
  assert.equal(limiter.recordFailure("100.64.0.7").limited, false);
  const blocked = limiter.recordFailure("100.64.0.7");
  assert.equal(blocked.limited, true);
  assert.equal(blocked.retryAfterSeconds, 10);

  now += 10_000;
  assert.equal(limiter.recordFailure("100.64.0.7").limited, false);
});

test("genuine loopback authorization failures are always exempt", () => {
  const limiter = new UnauthorizedRateLimiter({ maxFailures: 1 });
  for (const address of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(limiter.recordFailure(address).limited, false);
    assert.equal(limiter.recordFailure(address).limited, false);
  }
});

test("source cardinality is bounded and fails closed for an address spray", () => {
  const limiter = new UnauthorizedRateLimiter({ maxSources: 2 });
  assert.equal(limiter.recordFailure("100.64.0.1").limited, false);
  assert.equal(limiter.recordFailure("100.64.0.2").limited, false);
  assert.equal(limiter.recordFailure("100.64.0.3").limited, true);
});
