import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSCRIPT_AT_BOTTOM_PX,
  transcriptDistanceFromBottom,
  transcriptFollowsOutput,
  transcriptShowsJumpToNewest,
} from "./transcriptFollow";

const viewport = (distanceFromBottom: number, clientHeight = 800) => ({
  clientHeight,
  scrollHeight: 10_000,
  scrollTop: 10_000 - clientHeight - distanceFromBottom,
});

test("following output is decided by where the operator stands, not by elapsed time", () => {
  assert.equal(transcriptFollowsOutput(viewport(0)), true, "at the bottom, new output stays in view");
  assert.equal(
    transcriptFollowsOutput(viewport(TRANSCRIPT_AT_BOTTOM_PX)),
    true,
    "a few pixels of rounding is still standing at the bottom",
  );
  assert.equal(
    transcriptFollowsOutput(viewport(TRANSCRIPT_AT_BOTTOM_PX + 1)),
    false,
    "one row up is reading history, and a busy agent must not undo that",
  );
  assert.equal(
    transcriptFollowsOutput(viewport(4_000)),
    false,
    "a long turn appending rows for minutes never drags the viewport back",
  );
});

test("an over-scrolled or mid-bounce viewport is treated as the bottom rather than as history", () => {
  assert.equal(transcriptDistanceFromBottom(viewport(-40)), 0, "elastic overscroll is not a negative distance");
  assert.equal(transcriptFollowsOutput(viewport(-40)), true);
});

test("a transcript shorter than its viewport follows output", () => {
  assert.equal(
    transcriptFollowsOutput({ scrollTop: 0, scrollHeight: 300, clientHeight: 800 }),
    true,
    "there is nowhere to scroll, so the newest row is already in view",
  );
});

test("the jump-to-newest control needs a full screen of distance, not the follow threshold", () => {
  assert.equal(transcriptShowsJumpToNewest(viewport(TRANSCRIPT_AT_BOTTOM_PX + 1)), false);
  assert.equal(transcriptShowsJumpToNewest(viewport(799)), false);
  assert.equal(transcriptShowsJumpToNewest(viewport(800)), true);
});
