import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldFollowTranscript,
  transcriptFollowOutput,
} from "./transcriptFollow";

test("a manual scroll immediately stops the next append from following", () => {
  let following = shouldFollowTranscript({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 1_500 });
  assert.equal(transcriptFollowOutput(following), "auto");

  // This used to be ignored for 800 ms after an automatic scroll. The next
  // event could therefore drag the operator back down during a busy turn.
  following = shouldFollowTranscript({ scrollHeight: 2_000, clientHeight: 500, scrollTop: 900 });
  assert.equal(transcriptFollowOutput(following), false);
});

test("detached transcripts disable Virtuoso row and viewport resize following", () => {
  const following = shouldFollowTranscript({ scrollHeight: 2_300, clientHeight: 500, scrollTop: 900 });

  // Literal false, rather than a callback returning false, disables Virtuoso's
  // internal SIZE_INCREASED and VIEWPORT_HEIGHT_DECREASING follow paths.
  assert.strictEqual(transcriptFollowOutput(following), false);
});

test("returning to the bottom enables instant following again", () => {
  const following = shouldFollowTranscript({ scrollHeight: 2_300, clientHeight: 500, scrollTop: 1_798 });

  assert.equal(transcriptFollowOutput(following), "auto");
});
