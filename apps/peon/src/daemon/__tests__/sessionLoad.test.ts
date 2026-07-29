import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-load-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-load-state-"));

const fakeDir = mkdtempSync(path.join(os.tmpdir(), "peon-load-agent-"));
const fakeCodex = path.join(fakeDir, "codex.mjs");
writeFileSync(fakeCodex, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("end", () => {
  const payload = "x".repeat(16 * 1024);
  let batch = 0;
  console.log(JSON.stringify({ type: "thread.started", thread_id: "load-" + process.pid }));
  const timer = setInterval(() => {
    for (let i = 0; i < 10; i++) {
      const n = batch * 10 + i;
      console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", id: "tool-" + n, command: "tool " + n, aggregated_output: payload } }));
    }
    batch++;
    if (batch === 80) {
      clearInterval(timer);
      console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "done" } }));
      console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
    }
  }, 10);
});
`);
chmodSync(fakeCodex, 0o755);

const { createControlServer } = await import("../controlServer.js");
const { sessions } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");
const { transcriptPath } = await import("../sessions/sessionArtifacts.js");

settings.update({ codexCommand: fakeCodex, taskTimeoutMs: 20_000, maxTurns: 2_000 });

function percentile(values: number[], fraction: number): number {
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] ?? 0;
}

test("status remains responsive while two tool-heavy sessions preserve every event", async () => {
  const server: Server = createServer(createControlServer());
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();

  const first = sessions.start({ id: "load-one", prompt: "load", dir: fakeDir, agent: "codex" });
  const second = sessions.start({ id: "load-two", prompt: "load", dir: fakeDir, agent: "codex" });
  const latencies: number[] = [];
  let failures = 0;
  while (sessions.get(first.id)?.status !== "completed" || sessions.get(second.id)?.status !== "completed") {
    const started = performance.now();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/status`);
      await response.arrayBuffer();
      if (!response.ok) failures++;
    } catch {
      failures++;
    }
    latencies.push(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await sessions.flushTranscripts();
  delay.disable();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

  assert.equal(failures, 0);
  assert.ok(latencies.length >= 3, `expected sustained polling, got ${latencies.length} samples`);
  assert.ok(percentile(latencies, 0.95) < 100, `status p95 was ${percentile(latencies, 0.95).toFixed(1)}ms`);
  assert.ok(Math.max(...latencies) < 500, `status max was ${Math.max(...latencies).toFixed(1)}ms`);
  assert.ok(delay.max / 1e6 < 500, `event-loop delay max was ${(delay.max / 1e6).toFixed(1)}ms`);

  for (const id of [first.id, second.id]) {
    const record = sessions.get(id)!;
    const events = sessions.getTranscript(id);
    assert.equal(record.eventCount, 1_603);
    assert.equal(events.length, 1_604); // eventCount excludes the synthetic user message
    const persisted = readFileSync(transcriptPath(id), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(persisted.length, events.length);
    assert.ok(persisted.every((event) => typeof event._peonEventId === "string" && event._peonEventId.length > 0));
    const publicEvents = persisted.map(({ _peonEventId: _storageId, ...event }) => event);
    assert.deepEqual(publicEvents, JSON.parse(JSON.stringify(events)));
  }

  console.log(JSON.stringify({
    samples: latencies.length,
    p95Ms: Number(percentile(latencies, 0.95).toFixed(1)),
    maxMs: Number(Math.max(...latencies).toFixed(1)),
    eventLoopMaxMs: Number((delay.max / 1e6).toFixed(1)),
  }));
});
