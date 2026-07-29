import assert from "node:assert/strict";
import test from "node:test";
import { createBottomFrameScheduler } from "./useScrollToBottom";

test("bottom pinning coalesces layout growth and follows the latest frame", () => {
  const pinned = true;
  let scrolls = 0;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const scheduler = createBottomFrameScheduler(
    () => pinned,
    () => { scrolls += 1; },
    (callback) => {
      nextFrame += 1;
      frames.set(nextFrame, callback);
      return nextFrame;
    },
    (id) => { frames.delete(id); },
  );

  scheduler.schedule();
  scheduler.schedule();
  assert.equal(frames.size, 1);
  frames.get(1)?.(0);
  assert.equal(scrolls, 1);

  scheduler.schedule();
  frames.get(2)?.(0);
  assert.equal(scrolls, 2);
});

test("bottom pinning does not fight a user who scrolled up before layout settles", () => {
  let pinned = true;
  let scrolls = 0;
  let frame: FrameRequestCallback | null = null;
  const scheduler = createBottomFrameScheduler(
    () => pinned,
    () => { scrolls += 1; },
    (callback) => { frame = callback; return 1; },
    () => { frame = null; },
  );

  scheduler.schedule();
  pinned = false;
  (frame as FrameRequestCallback | null)?.(0);
  assert.equal(scrolls, 0);
});
