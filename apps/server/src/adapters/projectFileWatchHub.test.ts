import assert from "node:assert/strict";
import { test } from "node:test";
import type { WebSocket } from "ws";
import { ProjectFileWatchHub, FileWatchRefusal, type FileWatchClient } from "./projectFileWatchHub.js";

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function fixture() {
  const messages: Array<{ ws: WebSocket; type: string; watchId: string; code?: string; retryable?: boolean }> = [];
  const streams: Array<{ emit: (s: string) => void; signal: AbortSignal; end: () => void }> = [];
  const denied = new Set<string>();
  let identity = "project-1";
  const hub = new ProjectFileWatchHub((ws, msg) => messages.push({ ws, ...msg as Omit<typeof messages[number], "ws"> }), async (client) => {
    if (denied.has(client.userId)) throw new FileWatchRefusal("FORBIDDEN");
    return { identity, stream: (emit, signal) => new Promise<void>((end) => {
      streams.push({ emit, signal, end }); signal.addEventListener("abort", () => end(), { once: true });
    }) };
  });
  const client = (userId: string): FileWatchClient => ({ ws: {} as WebSocket, userId, actor: userId, workspaceId: "w", participant: null, closed: false });
  const request = (watchId: string) => ({ watchId, peonId: "p", projectKey: "project", path: "" });
  return { hub, messages, streams, denied, client, request, replaceProject: () => { identity = "project-2"; } };
}

test("two clients share upstream, ready reconciles, last unsubscribe aborts", async () => {
  const f = fixture(); const a = f.client("a"); const b = f.client("b");
  try {
    await f.hub.subscribe(a, f.request("a"));
    await f.hub.subscribe(b, f.request("b"));
    assert.equal(f.streams.length, 1);
    f.streams[0].emit("event: ready\r\ndata: {}\r\n\r\n"); await flush();
    assert.deepEqual(f.messages.map((m) => m.type), ["files:ready", "files:ready"]);
    f.streams[0].emit("event: cha"); f.streams[0].emit("nged\ndata: {}\n\n"); await flush();
    assert.deepEqual(f.messages.slice(2).map((m) => m.type), ["files:changed", "files:changed"]);
    f.hub.unsubscribe(a, "a"); assert.equal(f.streams[0].signal.aborted, false);
    f.hub.closeClient(b); assert.equal(f.streams[0].signal.aborted, true);
  } finally { f.hub.dispose(); }
});

test("revocation and project replacement are checked before delivery, including idle heartbeat", async () => {
  const f = fixture(); const a = f.client("a"); const b = f.client("b");
  try {
    await f.hub.subscribe(a, f.request("a")); await f.hub.subscribe(b, f.request("b"));
    f.streams[0].emit("event: ready\ndata: {}\n\n"); await flush(); f.messages.length = 0;
    f.denied.add("a"); f.streams[0].emit(": heartbeat\n\n"); await flush();
    assert.deepEqual(f.messages.map((m) => [m.watchId, m.type, m.code, m.retryable]), [["a", "files:error", "FORBIDDEN", false]]);
    f.replaceProject(); f.streams[0].emit("event: changed\ndata: {}\n\n"); await flush();
    assert.equal(f.messages.at(-1)?.code, "PROJECT_CHANGED");
    assert.equal(f.streams[0].signal.aborted, true);
  } finally { f.hub.dispose(); }
});

test("malformed/oversized frames and stream end fail boundedly and can resubscribe", async () => {
  const f = fixture(); const a = f.client("a");
  try {
    await f.hub.subscribe(a, f.request("a"));
    f.streams[0].emit("x".repeat(16_385)); await flush();
    assert.equal(f.streams[0].signal.aborted, true); assert.equal(f.messages.at(-1)?.retryable, true);
    await f.hub.subscribe(a, f.request("a")); assert.equal(f.streams.length, 2);
    f.streams[1].end(); await flush();
    assert.equal(f.messages.length, 2);
  } finally { f.hub.dispose(); }
});

test("participant, traversal, limits and disconnected pending authorization create no upstream", async () => {
  const f = fixture(); const a = f.client("a");
  try {
    a.participant = {}; await f.hub.subscribe(a, f.request("a")); a.participant = null;
    await f.hub.subscribe(a, { ...f.request("b"), path: "../private" });
    const pending = f.hub.subscribe(a, f.request("c")); f.hub.closeClient(a); await pending;
    assert.equal(f.streams.length, 0);
    for (let i = 0; i < 129; i++) await f.hub.subscribe(a, f.request(`w${i}`));
    assert.equal(f.messages.at(-1)?.code, "LIMIT");
  } finally { f.hub.dispose(); }
});
