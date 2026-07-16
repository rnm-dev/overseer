import assert from "node:assert/strict";
import test from "node:test";
import {
  createPeonSoundPlayer,
  isSuccessfulRunResult,
  PEON_SOUND_PATHS,
  PEON_SOUNDS_STORAGE_KEY,
  peonSoundsEnabled,
  setPeonSoundsEnabled,
} from "../peonSounds";

test("Peon lifecycle cues use the bundled semantic sound paths", () => {
  assert.deepEqual(PEON_SOUND_PATHS, {
    start: "/sounds/peon/work-start.wav",
    stop: "/sounds/peon/work-stop.wav",
    complete: "/sounds/peon/work-complete.wav",
  });
});

test("sound player reuses and rewinds audio without surfacing playback rejection", async () => {
  const created: string[] = [];
  let plays = 0;
  const player = createPeonSoundPlayer((src) => {
    created.push(src);
    return {
      currentTime: 4,
      preload: "none",
      play: () => {
        plays += 1;
        return Promise.reject(new Error("autoplay blocked"));
      },
    };
  });

  assert.doesNotThrow(() => player("start"));
  assert.doesNotThrow(() => player("start"));
  await Promise.resolve();
  assert.deepEqual(created, [PEON_SOUND_PATHS.start]);
  assert.equal(plays, 2);
});

test("only a successful fresh result qualifies as work completion", () => {
  assert.equal(isSuccessfulRunResult({ type: "result" }), true);
  assert.equal(isSuccessfulRunResult({ type: "result", is_error: false }), true);
  assert.equal(isSuccessfulRunResult({ type: "result", is_error: true }), false);
  assert.equal(isSuccessfulRunResult({ type: "assistant" }), false);
});

test("sound preference defaults on, persists off, and gates playback", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(peonSoundsEnabled(storage), true);
  setPeonSoundsEnabled(false, storage);
  assert.equal(values.get(PEON_SOUNDS_STORAGE_KEY), "false");
  assert.equal(peonSoundsEnabled(storage), false);

  let created = 0;
  const play = createPeonSoundPlayer(() => {
    created += 1;
    return { currentTime: 0, preload: "none", play: () => undefined };
  }, () => peonSoundsEnabled(storage));
  play("start");
  assert.equal(created, 0);
  setPeonSoundsEnabled(true, storage);
  play("start");
  assert.equal(created, 1);
});
