// Acceptance tests for the reliable SSE live-tail
// (GET /api/v1/sessions/:id/stream) — see PROTOCOL.md "Live tail". As in
// agentApi.projectFiles.test.ts, XDG_CONFIG_HOME/XDG_STATE_HOME are pointed at
// a scratch dir, and ACA_SSE_HEARTBEAT_MS shortens the heartbeat interval, all
// *before* any daemon module is imported (dynamic import, not static).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import express from "express";
import type { Server } from "node:http";

const configHome = mkdtempSync(path.join(os.tmpdir(), "peon-test-config-"));
const stateHome = mkdtempSync(path.join(os.tmpdir(), "peon-test-state-"));
process.env.XDG_CONFIG_HOME = configHome;
process.env.XDG_STATE_HOME = stateHome;
// Fast, deterministic heartbeats in tests instead of waiting out the real 15s+.
process.env.ACA_SSE_HEARTBEAT_MS = "60";

const { settings } = await import("../settings/index.js");
const { sessions } = await import("../sessions/index.js");
const { summaryPath, transcriptPath, sessionsDir } = await import("../sessions/sessionArtifacts.js");
const { createAgentRouter } = await import("../agentApi.js");

const TOKEN = "test-bearer-token";
settings.update({ overseerToken: TOKEN });

const app = express();
app.use(express.json());
app.use("/api/v1", createAgentRouter());
const server: Server = app.listen(0);
await new Promise<void>((resolve) => server.once("listening", resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}/api/v1`;

// Aborted SSE clients don't always tear down their socket in time for a plain
// server.close() to return promptly (it waits out lingering keep-alive
// connections) — force them shut so the process can exit.
test.after(() => {
  server.closeAllConnections();
  server.close();
});

// --- session fixture helper ---------------------------------------------
function makeSession(id: string, initialEventTexts: string[], initialEvents?: Record<string, unknown>[]): void {
  mkdirSync(sessionsDir, { recursive: true });
  const now = Date.now();
  const record = {
    id,
    prompt: "hello",
    title: null,
    followUpPrompts: [],
    dir: os.tmpdir(),
    agent: initialEvents ? "codex" : "claude-code",
    backendSessionId: null,
    model: null,
    reasoningEffort: null,
    projectKey: null,
    candidateProjectKeys: [],
    taskKey: null,
    taskTitle: null,
    initiator: null,
    expectsOutcome: false,
    status: "completed",
    outcome: null,
    startedAt: now,
    endedAt: now,
    turnCount: 0,
    turnBudget: 0,
    usage: null,
    usageByModel: {},
    autoResumeAttempts: 0,
    lastActivityAt: now,
    lastUserMessageAt: now,
    lastMessagePreview: null,
    eventCount: initialEvents?.length ?? initialEventTexts.length,
  };
  const events = initialEvents ?? initialEventTexts.map((text) => ({ type: "user_message", text }));
  writeFileSync(summaryPath(id), JSON.stringify(record, null, 2));
  writeFileSync(transcriptPath(id), events.length ? events.map((e) => `${JSON.stringify(e)}\n`).join("") : "");
  sessions.restoreFromDisk();
}

// Appends one live transcript event through the same append+emit path a real
// session run uses (sessions service's appendPreviewEvent), with no filesystem
// dependency: omitting `author` keeps normalizeStoredAgentEvent from
// filtering it regardless of extension.
function appendLiveEvent(id: string, marker: string): void {
  const event = sessions.preview(id, `/tmp/${marker}.txt`);
  assert.ok(event, `preview() accepted session ${id}`);
}

// --- minimal SSE client ---------------------------------------------------
interface Frame {
  event: string | null;
  id: string | null;
  data: string;
  comment: string | null;
}

function parseFrame(raw: string): Frame {
  const frame: Frame = { event: null, id: null, data: "", comment: null };
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) {
      frame.comment = line.slice(1).trim();
      continue;
    }
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx);
    const value = line.slice(idx + 1).replace(/^ /, "");
    if (field === "event") frame.event = value;
    else if (field === "id") frame.id = value;
    else if (field === "data") frame.data += (frame.data ? "\n" : "") + value;
  }
  return frame;
}

class SseClient {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private buf = "";
  private queue: Frame[] = [];
  readonly controller: AbortController;
  readonly ready: Promise<Response>;

  constructor(url: string, headers: Record<string, string> = {}) {
    this.controller = new AbortController();
    this.ready = fetch(url, { headers, signal: this.controller.signal });
    this.reader = null as unknown as ReadableStreamDefaultReader<Uint8Array>;
  }

  static async connect(url: string, headers: Record<string, string> = {}): Promise<SseClient> {
    const client = new SseClient(url, headers);
    const response = await client.ready;
    assert.equal(response.status, 200);
    client.reader = response.body!.getReader();
    return client;
  }

  private drainBuffered(): void {
    let idx;
    while ((idx = this.buf.indexOf("\n\n")) !== -1) {
      const raw = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      this.queue.push(parseFrame(raw));
    }
  }

  async next(timeoutMs = 3000): Promise<Frame> {
    this.drainBuffered();
    while (this.queue.length === 0) {
      const result = await Promise.race([
        this.reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE read timeout")), timeoutMs)),
      ]);
      if (result.done) throw new Error("SSE stream ended unexpectedly");
      this.buf += this.decoder.decode(result.value, { stream: true });
      this.drainBuffered();
    }
    return this.queue.shift()!;
  }

  async nextEvent(timeoutMs = 3000): Promise<Frame> {
    for (;;) {
      const frame = await this.next(timeoutMs);
      if (frame.event === "event") return frame;
    }
  }

  close(): void {
    this.controller.abort();
  }
}

function streamUrl(id: string): string {
  return `${base}/sessions/${id}/stream`;
}

test("unknown session returns a stable JSON error before any SSE headers", async () => {
  const res = await fetch(streamUrl("no-such-session"), { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-type")?.includes("application/json"), true);
  const body = (await res.json()) as any;
  assert.equal(body.code, "UNKNOWN_SESSION");
});

test("a fresh connection replays existing history in order, then delivers new live events with no gap", async () => {
  makeSession("s-replay", ["first", "second"]);
  const client = await SseClient.connect(streamUrl("s-replay"), { Authorization: `Bearer ${TOKEN}` });

  const f1 = await client.nextEvent();
  assert.match(f1.id ?? "", /^legacy_/);
  assert.equal(JSON.parse(f1.data).text, "first");
  const f2 = await client.nextEvent();
  assert.match(f2.id ?? "", /^legacy_/);
  assert.notEqual(f2.id, f1.id);
  assert.equal(JSON.parse(f2.data).text, "second");

  appendLiveEvent("s-replay", "live-one");
  const f3 = await client.nextEvent();
  assert.match(f3.id ?? "", /^[0-9a-f-]{36}$/i);

  client.close();
});

test("transcript snapshot and stream replay expose identical persisted edit diffs", async () => {
  const edit = {
    type: "assistant",
    message: { content: [{
      type: "tool_use", id: "edit-1", name: "Edit", input: { changes: [{
        path: "/workspace/a.ts", kind: "update",
        diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
      }] },
    }] },
  };
  makeSession("s-edit-diff", [], [edit]);

  // restoreFromDisk above exercises restart/resume decoding of the JSONL event.
  const snapshotResponse = await fetch(`${base}/sessions/s-edit-diff/transcript?limit=1`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  assert.equal(snapshotResponse.status, 200);
  const snapshot = (await snapshotResponse.json()) as { events: Array<Record<string, unknown> & { eventId: string }> };

  const client = await SseClient.connect(streamUrl("s-edit-diff"), { Authorization: `Bearer ${TOKEN}` });
  const frame = await client.nextEvent();
  const streamed = JSON.parse(frame.data);
  const { eventId, ...snapshotEvent } = snapshot.events[0];
  assert.equal(frame.id, eventId);
  assert.deepEqual(snapshotEvent, edit);
  assert.deepEqual(streamed, snapshotEvent);
  client.close();
});

test("transcript endpoint preserves its legacy response and supports bounded backward pages", async () => {
  makeSession("s-transcript-page", ["zero", "one", "two", "three", "four"]);
  const headers = { Authorization: `Bearer ${TOKEN}` };

  const legacyResponse = await fetch(`${base}/sessions/s-transcript-page/transcript`, { headers });
  assert.equal(legacyResponse.status, 200);
  const legacy = (await legacyResponse.json()) as { events: Array<{ text: string }>; nextCursor?: string };
  assert.deepEqual(legacy.events.map((event) => event.text), ["zero", "one", "two", "three", "four"]);
  assert.equal(legacy.nextCursor, undefined);

  const latestResponse = await fetch(`${base}/sessions/s-transcript-page/transcript?limit=2`, { headers });
  assert.equal(latestResponse.status, 200);
  const latest = (await latestResponse.json()) as {
    events: Array<{ text: string; eventId: string }>;
    nextCursor: string;
    hasMore: boolean;
  };
  assert.deepEqual(latest.events.map((event) => event.text), ["three", "four"]);
  assert.ok(latest.events.every((event) => event.eventId.startsWith("legacy_")));
  assert.equal(latest.hasMore, true);

  const earlierResponse = await fetch(
    `${base}/sessions/s-transcript-page/transcript?limit=2&cursor=${encodeURIComponent(latest.nextCursor)}`,
    { headers },
  );
  assert.equal(earlierResponse.status, 200);
  const earlier = (await earlierResponse.json()) as {
    events: Array<{ text: string; eventId: string }>;
    nextCursor: string;
    hasMore: boolean;
  };
  assert.deepEqual(earlier.events.map((event) => event.text), ["one", "two"]);
  assert.equal(earlier.hasMore, true);

  appendLiveEvent("s-transcript-page", "appended-after-page");
  const oldestResponse = await fetch(
    `${base}/sessions/s-transcript-page/transcript?limit=2&cursor=${encodeURIComponent(earlier.nextCursor)}`,
    { headers },
  );
  const oldest = (await oldestResponse.json()) as { events: Array<{ text: string }>; nextCursor: null; hasMore: boolean };
  assert.deepEqual(oldest.events.map((event) => event.text), ["zero"]);
  assert.equal(oldest.hasMore, false);
  assert.equal(oldest.nextCursor, null);

  const badCursor = await fetch(`${base}/sessions/s-transcript-page/transcript?cursor=not-a-cursor`, { headers });
  assert.equal(badCursor.status, 400);
  assert.deepEqual(await badCursor.json(), { error: "invalid transcript cursor", code: "BAD_CURSOR" });
});

test("id sequence has no gaps or duplicates across the replay/live boundary", async () => {
  makeSession("s-continuity", ["a", "b", "c", "d", "e"]);
  const client = await SseClient.connect(streamUrl("s-continuity"), { Authorization: `Bearer ${TOKEN}` });

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) ids.push((await client.nextEvent()).id ?? "");
  for (let i = 0; i < 5; i++) {
    appendLiveEvent("s-continuity", `live-${i}`);
    ids.push((await client.nextEvent()).id ?? "");
  }
  assert.equal(new Set(ids).size, 10);
  assert.ok(ids.every(Boolean));

  client.close();
});

test("a heartbeat comment arrives on an idle connection, and a live event still lands after it", async () => {
  makeSession("s-heartbeat", []);
  const client = await SseClient.connect(streamUrl("s-heartbeat"), { Authorization: `Bearer ${TOKEN}` });

  // ACA_SSE_HEARTBEAT_MS=60 in this test process — wait long enough to see
  // several without needing the real 15s+ production interval.
  let pings = 0;
  const deadline = Date.now() + 1000;
  while (pings < 2 && Date.now() < deadline) {
    const frame = await client.next(1500);
    if (frame.comment === "ping") pings++;
  }
  assert.ok(pings >= 2, `expected >=2 heartbeats, got ${pings}`);

  appendLiveEvent("s-heartbeat", "after-heartbeat");
  const ev = await client.nextEvent();
  assert.match(ev.id ?? "", /^[0-9a-f-]{36}$/i);

  client.close();
});

test("two simultaneous subscribers both receive the same ordered events", async () => {
  makeSession("s-fanout", []);
  const a = await SseClient.connect(streamUrl("s-fanout"), { Authorization: `Bearer ${TOKEN}` });
  const b = await SseClient.connect(streamUrl("s-fanout"), { Authorization: `Bearer ${TOKEN}` });

  appendLiveEvent("s-fanout", "one");
  appendLiveEvent("s-fanout", "two");
  appendLiveEvent("s-fanout", "three");

  const idsA: string[] = [];
  const idsB: string[] = [];
  for (let i = 0; i < 3; i++) idsA.push((await a.nextEvent()).id ?? "");
  for (let i = 0; i < 3; i++) idsB.push((await b.nextEvent()).id ?? "");
  assert.deepEqual(idsA, idsB);
  assert.equal(new Set(idsA).size, 3);

  a.close();
  b.close();
});

test("reconnecting with Last-Event-ID replays only what was missed, exactly once", async () => {
  makeSession("s-resume", ["one", "two"]);
  const a = await SseClient.connect(streamUrl("s-resume"), { Authorization: `Bearer ${TOKEN}` });
  const f1 = await a.nextEvent();
  const f2 = await a.nextEvent();
  assert.notEqual(f1.id, f2.id);
  const lastEventId = f2.id!;
  a.close();

  // Events land while nobody is subscribed.
  appendLiveEvent("s-resume", "three");
  appendLiveEvent("s-resume", "four");

  const b = await SseClient.connect(streamUrl("s-resume"), { Authorization: `Bearer ${TOKEN}`, "Last-Event-ID": lastEventId });
  const f3 = await b.nextEvent();
  const f4 = await b.nextEvent();
  assert.notEqual(f3.id, f4.id);
  assert.ok(f3.id && f4.id);
  // appendLiveEvent injects `preview` events (path/name), not user_message —
  // check the marker made it through the file name, not `.text`.
  assert.deepEqual([JSON.parse(f3.data).name, JSON.parse(f4.data).name], ["three.txt", "four.txt"]);

  // Live tail still works after a resumed replay.
  appendLiveEvent("s-resume", "five");
  const f5 = await b.nextEvent();
  assert.ok(f5.id);
  assert.notEqual(f5.id, f4.id);

  b.close();
});

test("afterEventId query resumes a native EventSource after a bounded snapshot", async () => {
  makeSession("s-query-resume", ["one", "two", "three"]);
  const snapshot = sessions.getTranscriptEntries("s-query-resume");
  const boundary = snapshot[1].id;

  const client = await SseClient.connect(
    `${streamUrl("s-query-resume")}?afterEventId=${encodeURIComponent(boundary)}`,
    { Authorization: `Bearer ${TOKEN}` },
  );
  const replay = await client.nextEvent();
  assert.equal(replay.id, snapshot[2].id);
  assert.equal(JSON.parse(replay.data).text, "three");

  appendLiveEvent("s-query-resume", "four");
  const live = await client.nextEvent();
  assert.equal(JSON.parse(live.data).name, "four.txt");
  client.close();
});

test("closing the connection unsubscribes the session listeners (no leak)", async () => {
  makeSession("s-cleanup", []);
  // Earlier tests' aborted clients tear down their server-side "close" event
  // asynchronously, independent of when each test itself returned — drain
  // those stragglers before counting, so this test's on/off spy only sees
  // its own connection's subscribe/unsubscribe pair.
  await new Promise((resolve) => setTimeout(resolve, 300));

  let onCalls = 0;
  let offCalls = 0;
  const originalOn = sessions.on;
  const originalOff = sessions.off;
  sessions.on = ((...args: Parameters<typeof sessions.on>) => {
    onCalls++;
    return originalOn(...args);
  }) as typeof sessions.on;
  sessions.off = ((...args: Parameters<typeof sessions.off>) => {
    offCalls++;
    return originalOff(...args);
  }) as typeof sessions.off;

  try {
    const client = await SseClient.connect(streamUrl("s-cleanup"), { Authorization: `Bearer ${TOKEN}` });
    assert.equal(onCalls, 2, "subscribes to both `event` and `change`");
    client.close();
    // req "close" fires asynchronously once the socket tears down.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(offCalls, 2, "unsubscribes from both `event` and `change` — same cleanup path clears the heartbeat timer");
  } finally {
    sessions.on = originalOn;
    sessions.off = originalOff;
  }
});
