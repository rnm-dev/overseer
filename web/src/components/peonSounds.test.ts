import assert from "node:assert/strict";
import test from "node:test";
import {
  createPeonSoundPlayer,
  createWorkSoundPlayer,
  isAgentWorkUpdate,
  isSuccessfulRunResult,
  LEGACY_PEON_SOUNDS_STORAGE_KEY,
  selectedSoundPack,
  setSelectedSoundPack,
  SOUND_PACK_PATHS,
  SOUND_PACK_STORAGE_KEY,
  SOUND_PACKS,
  SCV_WORKING_SOUND_PATHS,
} from "../peonSounds";

test("sound pack selector exposes the requested packs and bundled semantic paths", () => {
  assert.deepEqual(SOUND_PACKS.map(({ id }) => id), ["peon", "peasant", "none", "dota2_axe", "sc_scv"]);
  assert.deepEqual(SOUND_PACK_PATHS, {
    peon: {
      start: ["/sounds/peon/work-start.wav", "/sounds/peon/work-start-2.wav"],
      stop: ["/sounds/peon/work-stop.wav", "/sounds/peon/work-stop-2.wav"],
      complete: ["/sounds/peon/work-complete.wav", "/sounds/peon/work-start.wav"],
    },
    peasant: {
      start: ["/sounds/peasant/work-start.wav", "/sounds/peasant/work-start-2.wav"],
      stop: ["/sounds/peasant/work-stop.wav", "/sounds/peasant/work-stop-2.wav"],
      complete: ["/sounds/peasant/work-complete.wav", "/sounds/peasant/work-complete-2.wav"],
    },
    dota2_axe: {
      start: ["/sounds/dota2_axe/work-start.mp3", "/sounds/dota2_axe/work-start-2.mp3"],
      stop: ["/sounds/dota2_axe/work-stop.mp3", "/sounds/dota2_axe/work-stop-2.mp3"],
      complete: ["/sounds/dota2_axe/work-complete.mp3", "/sounds/dota2_axe/work-complete-2.mp3"],
    },
    sc_scv: {
      start: ["/sounds/sc_scv/work-start.mp3", "/sounds/sc_scv/work-start-2.mp3"],
      stop: ["/sounds/sc_scv/work-stop.mp3", "/sounds/sc_scv/work-stop-2.mp3"],
      complete: ["/sounds/sc_scv/work-complete.mp3", "/sounds/sc_scv/work-complete-2.mp3"],
    },
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
  }, undefined, () => 0);

  assert.doesNotThrow(() => player("start"));
  assert.doesNotThrow(() => player("start"));
  await Promise.resolve();
  assert.deepEqual(created, [SOUND_PACK_PATHS.peon.start[0]]);
  assert.equal(plays, 2);
});

test("only a successful fresh result qualifies as work completion", () => {
  assert.equal(isSuccessfulRunResult({ type: "result" }), true);
  assert.equal(isSuccessfulRunResult({ type: "result", is_error: false }), true);
  assert.equal(isSuccessfulRunResult({ type: "result", is_error: true }), false);
  assert.equal(isSuccessfulRunResult({ type: "assistant" }), false);
});

test("sound preference defaults to Peon, migrates the legacy toggle, and gates playback", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  assert.equal(selectedSoundPack(storage), "peon");
  values.set(LEGACY_PEON_SOUNDS_STORAGE_KEY, "false");
  assert.equal(selectedSoundPack(storage), "none");

  setSelectedSoundPack("dota2_axe", storage);
  assert.equal(values.get(SOUND_PACK_STORAGE_KEY), "dota2_axe");
  assert.equal(values.get(LEGACY_PEON_SOUNDS_STORAGE_KEY), "true");
  assert.equal(selectedSoundPack(storage), "dota2_axe");

  let created = 0;
  const play = createPeonSoundPlayer(() => {
    created += 1;
    return { currentTime: 0, preload: "none", play: () => undefined };
  }, () => selectedSoundPack(storage), () => 0);
  play("start");
  assert.equal(created, 1);
  setSelectedSoundPack("none", storage);
  play("start");
  assert.equal(created, 1);
});

test("sound player changes source when the selected pack changes", () => {
  let pack: "peon" | "sc_scv" = "peon";
  const created: string[] = [];
  const play = createPeonSoundPlayer((src) => {
    created.push(src);
    return { currentTime: 0, preload: "none", play: () => undefined };
  }, () => pack, () => 0);

  play("complete");
  pack = "sc_scv";
  play("complete");
  assert.deepEqual(created, [SOUND_PACK_PATHS.peon.complete[0], SOUND_PACK_PATHS.sc_scv.complete[0]]);
});

test("sound player randomly selects and caches candidates from the semantic pool", () => {
  let random = 0;
  const created: string[] = [];
  const play = createPeonSoundPlayer((src) => {
    created.push(src);
    return { currentTime: 0, preload: "none", play: () => undefined };
  }, () => "dota2_axe", () => random);

  play("start");
  random = 0.999;
  play("start");
  play("start");
  assert.deepEqual(created, SOUND_PACK_PATHS.dota2_axe.start);
});

test("SCV working sound plays once per update and ignores updates while a clip is active", () => {
  const created: Array<{ src: string; paused: boolean; currentTime: number; onended: (() => void) | null }> = [];
  const random = [0, 0, 0.99];
  const player = createWorkSoundPlayer((src) => {
    const audio = {
      src,
      paused: false,
      currentTime: 4,
      preload: "none",
      onended: null as (() => void) | null,
      pause() { this.paused = true; },
      play: () => undefined,
    };
    created.push(audio);
    return audio;
  }, () => "sc_scv", () => random.shift() ?? 0);

  player.play();
  player.play();
  assert.deepEqual(created.map(({ src }) => src), [SCV_WORKING_SOUND_PATHS[0]]);
  created[0].onended?.();
  player.play();
  created[1].onended?.();
  player.play();
  assert.deepEqual(created.map(({ src }) => src), [
    SCV_WORKING_SOUND_PATHS[0],
    SCV_WORKING_SOUND_PATHS[1],
    SCV_WORKING_SOUND_PATHS[4],
  ]);

  player.stop();
  assert.equal(created[2].paused, true);
  assert.equal(created[2].currentTime, 0);
  assert.equal(created[2].onended, null);
});

test("working sound plays only while the SCV pack is selected", () => {
  let pack: "sc_scv" | "peon" = "peon";
  let plays = 0;
  const player = createWorkSoundPlayer(() => ({
    currentTime: 0,
    preload: "none",
    onended: null,
    pause: () => undefined,
    play: () => { plays += 1; },
  }), () => pack, () => 0);

  player.play();
  pack = "sc_scv";
  player.play();
  assert.equal(plays, 1);
});

test("only assistant updates trigger the working sound", () => {
  assert.equal(isAgentWorkUpdate({ type: "assistant" }), true);
  assert.equal(isAgentWorkUpdate({ type: "user" }), false);
  assert.equal(isAgentWorkUpdate({ type: "system" }), false);
  assert.equal(isAgentWorkUpdate({ type: "preview" }), false);
  assert.equal(isAgentWorkUpdate({ type: "_raw" }), false);
  assert.equal(isAgentWorkUpdate({ type: "user_message" }), false);
  assert.equal(isAgentWorkUpdate({ type: "result" }), false);
});
