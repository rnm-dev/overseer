import assert from "node:assert/strict";
import test from "node:test";
import { requestProjectDirectory } from "./projectDirectoryListing";
import { PROJECT_FILE_POLL_INTERVAL_MS, startProjectFilePolling } from "./projectFilePolling";

const settled = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const page = () => Object.assign(new EventTarget(), { visibilityState: "visible" });

test("polling observes created, modified and removed files without a turn-end event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visible = page();
  let disk = [{ name: "existing.txt", size: 1, mtimeMs: 1 }];
  let shown = disk;
  const stop = startProjectFilePolling(async () => {
    shown = await requestProjectDirectory("/polling-test/files", "", async () => ({ entries: disk })) as typeof disk;
  }, visible, new EventTarget());
  t.after(stop);

  disk = [...disk, { name: "created.txt", size: 2, mtimeMs: 2 }];
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS);
  await settled();
  assert.deepEqual(shown, disk);
  disk = [{ name: "created.txt", size: 2, mtimeMs: 3 }];
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS);
  await settled();
  assert.deepEqual(shown, disk);
});

test("hidden tabs pause polling and returning to the tab refreshes immediately", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visible = page();
  const browser = new EventTarget();
  let calls = 0;
  const stop = startProjectFilePolling(async () => { calls++; }, visible, browser);
  t.after(stop);
  visible.visibilityState = "hidden";
  visible.dispatchEvent(new Event("visibilitychange"));
  browser.dispatchEvent(new Event("focus"));
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS * 10);
  assert.equal(calls, 0);

  visible.visibilityState = "visible";
  visible.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls, 1);
  await settled();
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS);
  assert.equal(calls, 2);
  await settled();
  browser.dispatchEvent(new Event("online"));
  assert.equal(calls, 3);
});

test("slow refreshes never overlap and focus requests coalesce into one follow-up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const browser = new EventTarget();
  let calls = 0;
  let finish!: () => void;
  const stop = startProjectFilePolling(() => {
    calls++;
    return new Promise<void>((resolve) => { finish = resolve; });
  }, page(), browser);
  t.after(stop);
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS);
  assert.equal(calls, 1);
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS * 10);
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("online"));
  assert.equal(calls, 1);
  finish();
  await settled();
  assert.equal(calls, 2);
  finish();
  await settled();
  assert.equal(calls, 2);
});

test("closing the tree removes listeners and an in-flight completion cannot restart polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const browser = new EventTarget();
  const visible = page();
  let calls = 0;
  let finish!: () => void;
  const stop = startProjectFilePolling(() => {
    calls++;
    return new Promise<void>((resolve) => { finish = resolve; });
  }, visible, browser);
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS);
  stop();
  finish();
  await settled();
  browser.dispatchEvent(new Event("focus"));
  browser.dispatchEvent(new Event("online"));
  visible.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS * 10);
  assert.equal(calls, 1);
});

test("a failed refresh does not disable future polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const stop = startProjectFilePolling(async () => {
    if (++calls === 1) throw new Error("offline");
  }, page(), new EventTarget());
  t.after(stop);
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS);
  await settled();
  t.mock.timers.tick(PROJECT_FILE_POLL_INTERVAL_MS);
  await settled();
  assert.equal(calls, 2);
});
