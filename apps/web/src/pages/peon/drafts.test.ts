import assert from "node:assert/strict";
import test from "node:test";

// The draft module talks to localStorage and IndexedDB directly, so the fakes
// have to be in place before it is imported (it memoises the database handle).
interface StoredFiles {
  files: File[];
  updatedAt: number;
}

const text = new Map<string, string>();
const records = new Map<string, StoredFiles>();

const localStorage = {
  getItem: (key: string) => (text.has(key) ? text.get(key)! : null),
  setItem: (key: string, value: string) => void text.set(key, value),
  removeItem: (key: string) => void text.delete(key),
};

// Enough of IndexedDB for one object store: every request resolves on the
// microtask queue, so the handlers the module attaches after the call still run.
function resolveLater<T>(result: T): { result: T; onsuccess?: () => void; onerror?: () => void } {
  const request: { result: T; onsuccess?: () => void; onerror?: () => void } = { result };
  queueMicrotask(() => request.onsuccess?.());
  return request;
}

const objectStore = {
  put: (value: StoredFiles, key: string) => void records.set(key, value),
  delete: (key: string) => void records.delete(key),
  get: (key: string) => resolveLater(records.get(key)),
  openCursor: () => resolveLater(null),
};

const db = {
  objectStoreNames: { contains: () => true },
  createObjectStore: () => objectStore,
  transaction: () => ({ objectStore: () => objectStore }),
};

(globalThis as { window?: unknown }).window = { localStorage };
(globalThis as { indexedDB?: unknown }).indexedDB = { open: () => resolveLater(db) };

// One turn of the microtask queue plus a macrotask: writes go through the
// database-open promise before they reach the fake store.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a composer draft is keyed per session, with one shared key for a new one", async () => {
  const { composerDraftKey } = await import("./drafts");
  assert.notEqual(composerDraftKey("ws", "peon", "sid-a"), composerDraftKey("ws", "peon", "sid-b"));
  assert.match(composerDraftKey("ws", "peon", null), /new-session$/);
});

test("saveComposerDraft persists both halves without waiting for a render", async () => {
  const { composerDraftKey, saveComposerDraft } = await import("./drafts");
  const key = composerDraftKey("ws", "peon", "sid");
  const file = new File(["hello"], "note.txt", { type: "text/plain" });

  saveComposerDraft(key, "unsent text", [file]);
  await settled();

  assert.equal(text.get(key), "unsent text");
  assert.deepEqual(records.get(key)?.files, [file]);
});

test("a text-only draft leaves no attachment record behind", async () => {
  const { composerDraftKey, saveComposerDraft } = await import("./drafts");
  const key = composerDraftKey("ws", "peon", "text-only");

  saveComposerDraft(key, "attached once", [new File(["x"], "a.txt")]);
  await settled();
  saveComposerDraft(key, "attached once", []);
  await settled();

  assert.equal(text.get(key), "attached once");
  assert.equal(records.has(key), false);
});

test("clearing attachment drafts preserves a new-session text draft", async () => {
  const { clearComposerDraftFiles, composerDraftKey, saveComposerDraft } = await import("./drafts");
  const key = composerDraftKey("ws", "peon", null);

  saveComposerDraft(key, "keep this prompt", [new File(["x"], "pasted.png", { type: "image/png" })]);
  await settled();
  clearComposerDraftFiles(key);
  await settled();

  assert.equal(text.get(key), "keep this prompt");
  assert.equal(records.has(key), false);
});

// The point of the imperative clear: a composer that navigates away on submit
// unmounts before its persistence effect could run.
test("clearComposerDraft removes the text and the attachments", async () => {
  const { clearComposerDraft, composerDraftKey, saveComposerDraft } = await import("./drafts");
  const key = composerDraftKey("ws", "peon", "cleared");

  saveComposerDraft(key, "sent", [new File(["x"], "a.txt")]);
  await settled();
  clearComposerDraft(key);
  await settled();

  assert.equal(localStorage.getItem(key), null);
  assert.equal(records.has(key), false);
});
