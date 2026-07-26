import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { checkVoiceQuota, estimateAudioSeconds, resetVoiceQuota } from "./voiceQuota.js";

const LIMITS = { requestsPerMinute: 3, audioSecondsPerHour: 60 };

beforeEach(() => resetVoiceQuota());

test("the audio charge is the larger of the declared duration and a byte estimate", () => {
  // An honest client is charged what it declared…
  assert.equal(estimateAudioSeconds(40_000, 15_000), 15);
  // …and a client that under-declares is charged for the bytes it actually sent.
  assert.equal(estimateAudioSeconds(400_000, 1_000), 100);
  assert.equal(estimateAudioSeconds(40_000, undefined), 10);
});

test("the request rate is per user and rolls off after a minute", () => {
  const now = 1_000_000;
  for (let i = 0; i < 3; i += 1) {
    assert.equal(checkVoiceQuota("u1", 1, LIMITS, now + i).allowed, true);
  }
  const blocked = checkVoiceQuota("u1", 1, LIMITS, now + 4);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "requests");
  assert.ok(blocked.retryAfterSeconds > 0 && blocked.retryAfterSeconds <= 60);

  // A different user is unaffected, and a minute later the first is clear again.
  assert.equal(checkVoiceQuota("u2", 1, LIMITS, now + 4).allowed, true);
  assert.equal(checkVoiceQuota("u1", 1, LIMITS, now + 61_000).allowed, true);
});

test("the rolling audio budget stops a user who stays under the request rate", () => {
  const now = 2_000_000;
  assert.equal(checkVoiceQuota("u3", 50, LIMITS, now).allowed, true);
  const blocked = checkVoiceQuota("u3", 20, LIMITS, now + 61_000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "audio-seconds");
  // A rejected request must not extend its own cool-off, so a smaller clip
  // that still fits is admitted immediately.
  assert.equal(checkVoiceQuota("u3", 5, LIMITS, now + 62_000).allowed, true);
});

test("the audio budget rolls off after an hour", () => {
  const now = 3_000_000;
  assert.equal(checkVoiceQuota("u4", 60, LIMITS, now).allowed, true);
  assert.equal(checkVoiceQuota("u4", 60, LIMITS, now + 59 * 60_000).allowed, false);
  assert.equal(checkVoiceQuota("u4", 60, LIMITS, now + 61 * 60_000).allowed, true);
});
