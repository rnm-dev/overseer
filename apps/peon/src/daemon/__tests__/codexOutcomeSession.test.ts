import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-codex-outcome-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-codex-outcome-state-"));

const fakeDir = mkdtempSync(path.join(os.tmpdir(), "peon-fake-codex-"));
const fakeCodex = path.join(fakeDir, "codex.mjs");
const rejectingCodex = path.join(fakeDir, "rejecting-codex.mjs");
const previewPath = path.join(fakeDir, "preview.md");
writeFileSync(previewPath, "# Preview\n");
writeFileSync(rejectingCodex, "#!/usr/bin/env node\nprocess.stderr.write('invalid configuration\\n');\nprocess.exit(1);\n");
chmodSync(rejectingCodex, 0o755);
writeFileSync(fakeCodex, `#!/usr/bin/env node
import { readFileSync } from "node:fs";
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  const schemaIndex = process.argv.indexOf("--output-schema");
  if (schemaIndex >= 0) {
    const schema = JSON.parse(readFileSync(process.argv[schemaIndex + 1], "utf8"));
    const validate = node => {
      if (!node || typeof node !== "object") return;
      if (node.type === "object") {
        const keys = Object.keys(node.properties || {});
        if (!Array.isArray(node.required) || keys.some(key => !node.required.includes(key))) {
          throw new Error("invalid_json_schema: missing required property");
        }
        Object.values(node.properties || {}).forEach(validate);
      }
      for (const key of ["anyOf", "oneOf", "allOf"]) (node[key] || []).forEach(validate);
      if (node.items) validate(node.items);
    };
    try { validate(schema); } catch (error) {
      console.log(JSON.stringify({ type: "error", message: error.message }));
      process.exitCode = 1;
      return;
    }
  }
  console.log(JSON.stringify({ type: "thread.started", thread_id: "fake-thread" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "command_execution", id: "tool-1", command: "pwd", aggregated_output: "/tmp" } }));
  const wantsOutcome = schemaIndex >= 0;
  const result = prompt.includes("NEEDS_HUMAN") ? "needs_human" : "success";
  const previewPath = prompt.includes("WITH_PREVIEW") ? ${JSON.stringify(previewPath)} : null;
  const automationMarkers = ["AUTOMATION_ONE", "AUTOMATION_TWO", "SYSTEM_ONLY"]
    .filter(marker => prompt.includes(marker));
  if (prompt.includes("The current Peon user is system")) automationMarkers.push("BAD_SYSTEM_USER");
  const text = wantsOutcome
    ? JSON.stringify({ result, summary: result + " from fake Codex", previewPath })
    : "ordinary chat response" + (automationMarkers.length ? " " + automationMarkers.join(" ") : "");
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 11, output_tokens: 7, cached_input_tokens: 2 } }));
});
`);
chmodSync(fakeCodex, 0o755);

const { readTranscript, summaryPath } = await import("../sessions/sessionArtifacts.js");
const { sessions, RESTART_INTERRUPTION_MARKER } = await import("../sessions/index.js");
const { settings } = await import("../settings/index.js");

settings.update({ codexCommand: fakeCodex, taskTimeoutMs: 2_000 });

async function waitUntilCompleted(id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (sessions.get(id)?.status === "completed") return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`session ${id} did not complete`);
}

async function waitUntil(id: string, predicate: (record: NonNullable<ReturnType<typeof sessions.get>>) => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const record = sessions.get(id);
    if (record && predicate(record)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`session ${id} did not reach the expected state`);
}

test("Codex outcome sessions persist previews, nulls, usage, and resumed outcomes", async () => {
  const record = sessions.start({
    id: "codex-outcome-session",
    prompt: "WITH_PREVIEW",
    dir: fakeDir,
    agent: "codex",
    expectsOutcome: true,
  });
  await waitUntilCompleted(record.id);

  assert.deepEqual(sessions.get(record.id)?.outcome, {
    result: "success",
    summary: "success from fake Codex",
    previewPath,
  });
  assert.equal(sessions.get(record.id)?.turnCount, 1);
  assert.equal(sessions.get(record.id)?.usage?.inputTokens, 11);
  assert.ok(readTranscript(record.id, "codex").some((event) => event.type === "assistant"));
  assert.equal(JSON.parse(readFileSync(summaryPath(record.id), "utf8")).outcome.previewPath, previewPath);

  sessions.resume(record.id, "NEEDS_HUMAN");
  await waitUntilCompleted(record.id);
  assert.deepEqual(sessions.get(record.id)?.outcome, {
    result: "needs_human",
    summary: "needs_human from fake Codex",
    previewPath: null,
  });
  assert.equal(sessions.get(record.id)?.turnCount, 2);
});

test("ordinary Codex chat sessions remain unconstrained", async () => {
  const record = sessions.start({
    id: "codex-chat-session",
    prompt: "hello",
    dir: fakeDir,
    agent: "codex",
    expectsOutcome: false,
  });
  await waitUntilCompleted(record.id);
  assert.equal(sessions.get(record.id)?.outcome, null);
  assert.ok(readTranscript(record.id, "codex").some((event) => event.type === "assistant"));
});

test("session runtime emits completion after persisting the terminal record", async () => {
  const id = "codex-completion-event-session";
  let observed: ReturnType<typeof sessions.get> = undefined;
  const onComplete = (record: NonNullable<ReturnType<typeof sessions.get>>) => {
    if (record.id === id) observed = record;
  };
  sessions.on("complete", onComplete);
  try {
    sessions.start({
      id,
      prompt: "hello",
      dir: fakeDir,
      agent: "codex",
      expectsOutcome: false,
    });
    await waitUntilCompleted(id);
    assert.equal(observed?.id, id);
    assert.equal(observed?.status, "completed");
    assert.ok(observed?.endedAt);
    assert.equal(JSON.parse(readFileSync(summaryPath(id), "utf8")).status, "completed");
  } finally {
    sessions.off("complete", onComplete);
  }
});

test("queued follow-ups persist and dispatch one per completed turn in FIFO order", async () => {
  const record = sessions.start({
    id: "codex-queued-session",
    prompt: "first",
    dir: fakeDir,
    agent: "codex",
  });
  record.parentCompletionNotificationPending = true;
  const attachment = { originalName: "note.txt", filename: "note.txt", path: previewPath, size: 10, mimetype: "text/plain" };
  sessions.enqueue(record.id, "second", [attachment], "plan", "alice", "gpt-5.1-codex-mini", "medium");
  sessions.enqueue(record.id, "third", [], undefined, "bob", undefined, "high");
  sessions.enqueue(record.id, "remove me");
  const removable = sessions.queued(record.id)!.at(-1)!;
  assert.equal(sessions.editQueued("missing", removable.id, "edited"), "unknown_session");
  assert.equal(sessions.editQueued(record.id, "missing", "edited"), "not_found");
  const edited = sessions.editQueued(record.id, removable.id, "edited before removal");
  assert.notEqual(edited, "not_found");
  assert.notEqual(edited, "unknown_session");
  assert.equal(sessions.queued(record.id)!.at(-1)!.prompt, "edited before removal");
  assert.equal(JSON.parse(readFileSync(summaryPath(record.id), "utf8")).queuedFollowUps.at(-1).prompt, "edited before removal");
  assert.equal(sessions.removeQueued(record.id, removable.id), "removed");
  assert.equal(sessions.removeQueued(record.id, removable.id), "not_found");
  assert.equal(sessions.removeQueued("missing", removable.id), "unknown_session");

  const persistedWhileRunning = JSON.parse(readFileSync(summaryPath(record.id), "utf8"));
  assert.deepEqual(persistedWhileRunning.queuedFollowUps.map((item: { prompt: string }) => item.prompt), ["second", "third"]);

  for (let i = 0; i < 300; i++) {
    const current = sessions.get(record.id)!;
    if (current.status === "completed" && current.queuedFollowUps.length === 0 && current.followUpPrompts.length === 2) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const current = sessions.get(record.id)!;
  assert.equal(current.status, "completed");
  assert.deepEqual(current.followUpPrompts, ["second", "third"]);
  assert.deepEqual(current.queuedFollowUps, []);
  assert.equal(current.parentCompletionNotificationPending, false);
  assert.deepEqual(
    readTranscript(record.id, "codex").filter((event) => event.type === "user_message").map((event) => [event.text, event.author, event.model, event.reasoningEffort, (event.attachments as unknown[] | undefined)?.length ?? 0]),
    [
      ["first", undefined, undefined, undefined, 0],
      ["second", "alice", "gpt-5.1-codex-mini", "medium", 1],
      ["third", "bob", undefined, "high", 0],
    ],
  );
});

test("hidden system triggers coalesce into the next queued user turn", async () => {
  const record = sessions.start({
    id: "codex-coalesced-system-session",
    prompt: "first",
    dir: fakeDir,
    agent: "codex",
    expectsOutcome: false,
  });
  sessions.enqueue(record.id, "visible user follow-up");
  sessions.enqueueSystem(record.id, "Process AUTOMATION_ONE.", "automation-one");
  sessions.enqueueSystem(record.id, "Process AUTOMATION_TWO.", "automation-two");
  sessions.enqueueSystem(record.id, "Duplicate AUTOMATION_TWO.", "automation-two");

  assert.deepEqual(sessions.queued(record.id)?.map((item) => item.prompt), ["visible user follow-up"]);
  assert.equal(JSON.parse(readFileSync(summaryPath(record.id), "utf8")).pendingSystemPrompts.length, 2);

  await waitUntil(record.id, (current) => current.status === "completed"
    && current.queuedFollowUps.length === 0
    && current.pendingSystemPrompts.length === 0
    && current.followUpPrompts.length === 1);

  const transcript = readTranscript(record.id, "codex");
  assert.deepEqual(
    transcript.filter((event) => event.type === "user_message").map((event) => event.text),
    ["first", "visible user follow-up"],
  );
  assert.equal(
    transcript.filter((event) => event.type === "user_message")
      .some((event) => JSON.stringify(event).includes("AUTOMATION_")),
    false,
  );
  assert.match(JSON.stringify(transcript.filter((event) => event.type === "assistant")), /AUTOMATION_ONE/);
  assert.match(JSON.stringify(transcript.filter((event) => event.type === "assistant")), /AUTOMATION_TWO/);
  assert.deepEqual(JSON.parse(readFileSync(summaryPath(record.id), "utf8")).pendingSystemPrompts, []);
});

test("hidden system triggers start one invisible automation turn when no user message is queued", async () => {
  const record = sessions.start({
    id: "codex-system-only-session",
    prompt: "first",
    dir: fakeDir,
    agent: "codex",
    expectsOutcome: false,
  });
  sessions.enqueueSystem(record.id, "Process SYSTEM_ONLY.", "system-only");

  assert.deepEqual(sessions.queued(record.id), []);
  await waitUntil(record.id, (current) => current.status === "completed"
    && current.pendingSystemPrompts.length === 0
    && current.turnCount === 2);

  const transcript = readTranscript(record.id, "codex");
  assert.deepEqual(
    transcript.filter((event) => event.type === "user_message").map((event) => event.text),
    ["first"],
  );
  assert.match(JSON.stringify(transcript.filter((event) => event.type === "assistant")), /SYSTEM_ONLY/);
  assert.doesNotMatch(JSON.stringify(transcript.filter((event) => event.type === "assistant")), /BAD_SYSTEM_USER/);
});

test("restart-interrupted parents still dispatch durable hidden triggers", async () => {
  const record = sessions.start({
    id: "codex-restart-hidden-system-session",
    prompt: "first",
    dir: fakeDir,
    agent: "codex",
    expectsOutcome: false,
  });
  await waitUntilCompleted(record.id);
  record.outcome = { result: "failure", summary: `Daemon ${RESTART_INTERRUPTION_MARKER}.` };
  record.pendingSystemPrompts.push({
    prompt: "Process SYSTEM_ONLY.",
    commandId: "system-after-restart",
    queuedAt: Date.now(),
  });

  sessions.resumeQueued();
  await waitUntil(record.id, (current) => current.status === "completed"
    && current.pendingSystemPrompts.length === 0
    && current.turnCount === 2);

  assert.match(JSON.stringify(readTranscript(record.id, "codex")), /SYSTEM_ONLY/);
});

test("hidden triggers remain durable when the agent CLI cannot spawn or rejects configuration", async () => {
  const record = sessions.start({
    id: "codex-system-start-failure-session",
    prompt: "first",
    dir: fakeDir,
    agent: "codex",
    expectsOutcome: false,
  });
  await waitUntilCompleted(record.id);
  settings.update({ codexCommand: path.join(fakeDir, "missing-codex") });
  try {
    sessions.enqueueSystem(record.id, "Process SYSTEM_ONLY.", "system-start-failure");
    await waitUntil(record.id, (current) => current.status === "completed"
      && current.outcome?.summary.includes("Failed to start agent CLI") === true);
    assert.equal(record.pendingSystemPrompts.length, 1);
    assert.equal(record.pendingSystemPrompts[0]?.commandId, "system-start-failure");

    settings.update({ codexCommand: rejectingCodex });
    sessions.resumeQueued();
    await waitUntil(record.id, (current) => current.status === "completed"
      && current.outcome?.summary.includes("Process exited") === true);
    assert.equal(record.pendingSystemPrompts.length, 1);
    assert.equal(record.pendingSystemPrompts[0]?.commandId, "system-start-failure");
  } finally {
    settings.update({ codexCommand: fakeCodex });
  }
});

test("stopping a running session still advances a pending hidden system turn", async () => {
  const record = sessions.start({
    id: "codex-stop-with-system-session",
    prompt: "first",
    dir: fakeDir,
    agent: "codex",
    expectsOutcome: false,
  });
  sessions.enqueueSystem(record.id, "Process SYSTEM_ONLY.", "system-after-stop");

  assert.equal(sessions.cancel(record.id), true);
  for (let i = 0; i < 300; i++) {
    const current = sessions.get(record.id)!;
    if (current.status === "completed"
      && current.pendingSystemPrompts.length === 0
      && JSON.stringify(readTranscript(record.id, "codex")).includes("SYSTEM_ONLY")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const current = sessions.get(record.id)!;
  assert.equal(
    current.status === "completed"
      && current.pendingSystemPrompts.length === 0
      && JSON.stringify(readTranscript(record.id, "codex")).includes("SYSTEM_ONLY"),
    true,
    JSON.stringify({
      status: current.status,
      pendingSystemPrompts: current.pendingSystemPrompts,
      outcome: current.outcome,
      transcript: readTranscript(record.id, "codex"),
    }),
  );

  assert.deepEqual(
    readTranscript(record.id, "codex").filter((event) => event.type === "user_message").map((event) => event.text),
    ["first"],
  );
});

test("send now promotes the selected queued follow-up and survives a teardown race", async (t) => {
  const activityChanges: Array<{ status: string; activeCount: number }> = [];
  const onChange = (changed: NonNullable<ReturnType<typeof sessions.get>>) => {
    if (changed.id === "codex-send-queued-now-session") {
      activityChanges.push({ status: changed.status, activeCount: sessions.activeCount() });
    }
  };
  sessions.on("change", onChange);
  t.after(() => sessions.off("change", onChange));
  const record = sessions.start({
    id: "codex-send-queued-now-session",
    prompt: "first",
    dir: fakeDir,
    agent: "codex",
  });
  sessions.enqueue(record.id, "second");
  sessions.enqueue(record.id, "third");
  sessions.enqueue(record.id, "fourth");
  const queued = sessions.queued(record.id)!;

  assert.equal(sessions.sendQueuedNow("missing", queued[1].id), "unknown_session");
  assert.equal(sessions.sendQueuedNow(record.id, "missing"), "not_found");
  assert.equal(sessions.sendQueuedNow(record.id, queued[1].id), "sent");
  assert.deepEqual(sessions.queued(record.id)!.map((item) => item.prompt), ["third", "second", "fourth"]);

  // A second operator choice can arrive while the first interrupt is still
  // tearing down. It changes the durable head without starting another kill.
  assert.equal(sessions.sendQueuedNow(record.id, queued[2].id), "sent");
  assert.deepEqual(sessions.queued(record.id)!.map((item) => item.prompt), ["fourth", "third", "second"]);
  assert.deepEqual(
    JSON.parse(readFileSync(summaryPath(record.id), "utf8")).queuedFollowUps.map((item: { prompt: string }) => item.prompt),
    ["fourth", "third", "second"],
  );

  for (let i = 0; i < 400; i++) {
    const current = sessions.get(record.id)!;
    if (current.status === "completed" && current.queuedFollowUps.length === 0 && current.followUpPrompts.length === 3) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const current = sessions.get(record.id)!;
  assert.equal(current.status, "completed");
  assert.deepEqual(current.followUpPrompts, ["fourth", "third", "second"]);
  assert.deepEqual(current.queuedFollowUps, []);
  assert.ok(
    activityChanges.some((change) => change.status === "running" && change.activeCount === 1),
    JSON.stringify(activityChanges),
  );
  assert.equal(
    activityChanges.some((change) => change.status === "running" && change.activeCount === 0),
    false,
    JSON.stringify(activityChanges),
  );
  assert.equal(
    activityChanges.some((change) => change.status === "completed" && change.activeCount !== 0),
    false,
    JSON.stringify(activityChanges),
  );
});

test("stopping a running session advances its queued follow-up", async () => {
  const record = sessions.start({
    id: "codex-stop-with-queue-session",
    prompt: "first",
    dir: fakeDir,
    agent: "codex",
  });
  sessions.enqueue(record.id, "second");

  assert.equal(sessions.cancel(record.id), true);

  for (let i = 0; i < 300; i++) {
    const current = sessions.get(record.id)!;
    if (current.status === "completed" && current.queuedFollowUps.length === 0 && current.followUpPrompts.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const current = sessions.get(record.id)!;
  assert.equal(current.status, "completed");
  assert.deepEqual(current.queuedFollowUps, []);
  assert.deepEqual(current.followUpPrompts, ["second"]);
  assert.ok(readTranscript(record.id, "codex").some((event) => event.type === "user_message" && event.text === "second"));
});

test("queue and send-now publishes the restarted turn as active", async () => {
  const id = "codex-queue-and-send-now-activity-session";
  const activityChanges: Array<{ status: string; activeCount: number }> = [];
  const onChange = (changed: NonNullable<ReturnType<typeof sessions.get>>) => {
    if (changed.id === id) activityChanges.push({ status: changed.status, activeCount: sessions.activeCount() });
  };
  sessions.on("change", onChange);
  try {
    const record = sessions.start({ id, prompt: "first", dir: fakeDir, agent: "codex" });
    sessions.enqueue(record.id, "second", [], undefined, undefined, undefined, undefined, undefined, true);

    await waitUntil(record.id, (current) =>
      current.status === "completed"
      && current.queuedFollowUps.length === 0
      && current.followUpPrompts.length === 1);

    assert.ok(
      activityChanges.some((change) => change.status === "running" && change.activeCount === 1),
      JSON.stringify(activityChanges),
    );
    assert.equal(
      activityChanges.some((change) => change.status === "running" && change.activeCount === 0),
      false,
      JSON.stringify(activityChanges),
    );
    assert.equal(
      activityChanges.some((change) => change.status === "completed" && change.activeCount !== 0),
      false,
      JSON.stringify(activityChanges),
    );
  } finally {
    sessions.off("change", onChange);
  }
});
