import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-unified-api-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-unified-api-state-"));

const { settings } = await import("../settings/index.js");
const { createControlServer } = await import("../controlServer.js");
const { sessions } = await import("../sessions/index.js");

const token = "pn_unified_api_test";
settings.update({ overseerToken: token });

const fakeAgentDir = mkdtempSync(path.join(os.tmpdir(), "peon-unified-queue-agent-"));
const fakeAgent = path.join(fakeAgentDir, "agent.mjs");
writeFileSync(fakeAgent, "#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 5000);\n");
chmodSync(fakeAgent, 0o755);
settings.update({ agentCommand: fakeAgent, taskTimeoutMs: 10_000 });

const server = createControlServer().listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;

test.after(() => server.close());

test("/api/v1 selects human and fleet status representations by credentials", async () => {
  const humanResponse = await fetch(`${base}/api/v1/status`);
  assert.equal(humanResponse.status, 200);
  const human = (await humanResponse.json()) as Record<string, unknown>;
  assert.equal(typeof human.uptimeSec, "number");
  assert.equal(human.protocol, undefined);

  const fleetResponse = await fetch(`${base}/api/v1/status`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(fleetResponse.status, 200);
  const fleet = (await fleetResponse.json()) as Record<string, unknown>;
  assert.equal(fleet.protocol, 1);
  assert.equal(typeof fleet.activeSessionCount, "number");
  assert.equal(fleet.state, undefined);
});

test("flexible analytics is available through human and fleet profiles with profile-specific errors", async () => {
  const human = await fetch(`${base}/api/v1/ai/analytics?period=all&groupBy=user,project,time&timeBucket=day`);
  assert.equal(human.status, 200);
  const humanBody = (await human.json()) as { groupBy: string[]; timeZone: string; totals: { sessionCount: number } };
  assert.deepEqual(humanBody.groupBy, ["user", "project", "time"]);
  assert.equal(humanBody.timeZone, "UTC");
  assert.equal(typeof humanBody.totals.sessionCount, "number");

  const headers = { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" };
  const fleet = await fetch(`${base}/api/v1/analytics?period=all&groupBy=project`, { headers });
  assert.equal(fleet.status, 200);
  const fleetBody = (await fleet.json()) as { groupBy: string[]; attribution: { project: string } };
  assert.deepEqual(fleetBody.groupBy, ["project"]);
  assert.equal(fleetBody.attribution.project, "session_project_id");

  const badHuman = await fetch(`${base}/api/v1/ai/analytics?timeBucket=day`);
  assert.equal(badHuman.status, 400);
  assert.equal(((await badHuman.json()) as { code: string }).code, "BAD_ANALYTICS_QUERY");
  const badFleet = await fetch(`${base}/api/v1/analytics?timeBucket=day`, { headers });
  assert.equal(badFleet.status, 400);
  assert.equal(((await badFleet.json()) as { code: string }).code, "BAD_REQUEST");
});

test("human control API persists and clears the Peon soul", async () => {
  const soul = "## Character\n\nBe practical and candid.";
  const updated = await fetch(`${base}/api/v1/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ soul }),
  });
  assert.equal(updated.status, 200);
  const updatedBody = (await updated.json()) as { soul: string; ai: { soul: string } };
  assert.equal(updatedBody.soul, soul);
  assert.equal(updatedBody.ai.soul, soul);

  const cleared = await fetch(`${base}/api/v1/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ soul: null }),
  });
  assert.equal(cleared.status, 200);
  const clearedBody = (await cleared.json()) as { soul: null; ai: { soul: string } };
  assert.equal(clearedBody.soul, null);
  assert.equal(clearedBody.ai.soul, "");
});

test("human and fleet APIs expose and select the app-server driver explicitly", async () => {
  const catalogResponse = await fetch(`${base}/api/v1/models`);
  assert.equal(catalogResponse.status, 200);
  const catalog = (await catalogResponse.json()) as { providers: Array<{ agent: string; legacy?: boolean; status?: { status?: string } }> };
  assert.equal(catalog.providers.some((provider) => provider.agent === "codex"), false);
  assert.equal(catalog.providers.find((provider) => provider.agent === "codex-app-server")?.status?.status, "stopped");

  const selected = await fetch(`${base}/api/v1/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      defaultAgent: "codex-app-server",
      aiDefaultModel: "gpt-5.4",
      aiDefaultReasoningEffort: "xhigh",
    }),
  });
  assert.equal(selected.status, 200);
  const selectedSettings = (await selected.json()) as {
    defaultAgent: string;
    aiDefaultReasoningEffort: string;
    ai: { defaultReasoningEffort: string };
  };
  assert.equal(selectedSettings.defaultAgent, "codex-app-server");
  assert.equal(selectedSettings.aiDefaultReasoningEffort, "xhigh");
  assert.equal(selectedSettings.ai.defaultReasoningEffort, "xhigh");

  const invalidEffort = await fetch(`${base}/api/v1/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      defaultAgent: "claude-code",
      aiDefaultModel: "claude-haiku-4-5-20251001",
      aiDefaultReasoningEffort: "high",
    }),
  });
  assert.equal(invalidEffort.status, 400);

  const fleet = await fetch(`${base}/api/v1/settings`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(((await fleet.json()) as { defaultAgent: string }).defaultAgent, "codex-app-server");
  settings.update({ defaultAgent: "claude-code", ai: { ...settings.get().ai, defaultModel: "claude-sonnet-5" } });
});

test("human API can re-point a project through its settings path", async () => {
  const createResponse = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Human Folder Settings" }),
  });
  assert.equal(createResponse.status, 201);
  const created = (await createResponse.json()) as { projectId: string; key: string; dir: string };
  assert.match(created.projectId, /^[0-9a-f-]{36}$/i);
  const session = sessions.start({ id: "project-key-rename-session", prompt: "keep running", dir: created.dir, projectKey: created.key });
  assert.equal(session.projectId, created.projectId);
  const newDir = path.join(mkdtempSync(path.join(os.tmpdir(), "peon-human-project-parent-")), "new folder");
  const newKey = "renamed-human-folder-settings";
  const newName = "Renamed Human Folder Settings";

  const updateResponse = await fetch(`${base}/api/v1/projects/${created.key}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: newKey, name: newName, dir: newDir }),
  });
  assert.equal(updateResponse.status, 200);
  assert.deepEqual(await updateResponse.json(), { projectId: created.projectId, key: newKey, name: newName, dir: newDir });
  assert.equal(existsSync(newDir), true);
  assert.equal(session.projectKey, newKey);
  assert.equal(session.projectId, created.projectId);

  const readResponse = await fetch(`${base}/api/v1/projects/${newKey}/settings`);
  assert.equal(readResponse.status, 200);
  assert.deepEqual(await readResponse.json(), { projectId: created.projectId, key: newKey, name: newName, dir: newDir });
  const projectsResponse = await fetch(`${base}/api/v1/projects`);
  const projects = (await projectsResponse.json()) as { projects: Array<{ projectId: string; key: string }> };
  assert.equal(projects.projects.find((project) => project.key === newKey)?.projectId, created.projectId);

  const listResponse = await fetch(`${base}/api/v1/sessions`);
  const listed = (await listResponse.json()) as { sessions: Array<Record<string, unknown>> };
  const summary = listed.sessions.find((item) => item.id === session.id);
  assert.equal(summary?.projectId, created.projectId);
  assert.deepEqual(Object.keys(summary ?? {}), [
    "id", "status", "projectKey", "projectId", "title", "promptPreview",
    "lastMessagePreview", "initiator", "outcome", "terminalReason", "startedAt", "endedAt", "lastActivityAt",
  ]);
  assert.equal(summary?.promptPreview, "keep running");
  assert.equal("prompt" in (summary ?? {}), false);

  const fleetListResponse = await fetch(`${base}/api/v1/sessions`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  const fleetListed = (await fleetListResponse.json()) as { sessions: Array<Record<string, unknown>> };
  assert.deepEqual(fleetListed.sessions.find((item) => item.id === session.id), summary);

  const detailResponse = await fetch(`${base}/api/v1/sessions/${session.id}`);
  const detail = (await detailResponse.json()) as { projectId: string | null; prompt: string };
  assert.equal(detail.projectId, created.projectId);
  assert.equal(detail.prompt, "keep running");
  sessions.cancel(session.id);
});

test("human and fleet project routes share one application-service result", async () => {
  const fleetHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Peon-Protocol": "1",
  };
  const createdResponse = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Project Service Parity" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as { projectId: string; key: string; onboardingSessionId: string };
  assert.match(created.onboardingSessionId, /^[0-9a-f-]{36}$/i);
  const onboarding = sessions.get(created.onboardingSessionId);
  assert.equal(onboarding?.projectKey, created.key);
  assert.equal(onboarding?.title, "Set up project documentation");

  const renamedKey = "project-service-parity-renamed";
  const fleetUpdate = await fetch(`${base}/api/v1/projects/${created.key}/settings`, {
    method: "PATCH",
    headers: fleetHeaders,
    body: JSON.stringify({ key: renamedKey, name: "Project Service Parity Renamed" }),
  });
  assert.equal(fleetUpdate.status, 200);

  const [humanDetail, fleetDetail] = await Promise.all([
    fetch(`${base}/api/v1/projects/${renamedKey}`),
    fetch(`${base}/api/v1/projects/${renamedKey}`, { headers: fleetHeaders }),
  ]);
  assert.equal(humanDetail.status, 200);
  assert.equal(fleetDetail.status, 200);
  assert.deepEqual(await humanDetail.json(), await fleetDetail.json());

  sessions.cancel(created.onboardingSessionId);
  const removed = await fetch(`${base}/api/v1/projects/${renamedKey}`, { method: "DELETE", headers: fleetHeaders });
  assert.equal(removed.status, 200);
  const missing = await fetch(`${base}/api/v1/projects/${renamedKey}`);
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "unknown project" });
});

test("authenticated fleet requests reach project settings without local-profile 401s", async () => {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Peon-Protocol": "1",
    "Peon-Actor": "owner@example.com",
  };
  const createdResponse = await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers,
    body: JSON.stringify({ label: "Fleet Auth Settings" }),
  });
  assert.equal(createdResponse.status, 201);
  const created = (await createdResponse.json()) as { key: string };

  const readResponse = await fetch(`${base}/api/v1/projects/${created.key}/settings`, { headers });
  assert.equal(readResponse.status, 200);

  const updateResponse = await fetch(`${base}/api/v1/projects/${created.key}/settings`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Fleet Auth Settings Updated" }),
  });
  assert.equal(updateResponse.status, 200);
  assert.equal(((await updateResponse.json()) as { name: string }).name, "Fleet Auth Settings Updated");
});

test("fleet credentials select fleet auth for control mutations", async () => {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Peon-Protocol": "1",
    "Peon-Actor": "owner@example.com",
  };

  const statusResponse = await fetch(`${base}/api/v1/status`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(statusResponse.status, 200);
  const status = (await statusResponse.json()) as { paused: boolean; protocol: number };
  assert.equal(status.paused, true);
  assert.equal(status.protocol, 1);

  // Restore global settings for tests sharing this process.
  settings.update({ paused: false });
});

test("an Authorization header never falls through to local-only auth", async () => {
  const response = await fetch(`${base}/api/v1/status`, {
    method: "PATCH",
    headers: { Authorization: "invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ paused: true }),
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), {
    error: "missing or invalid bearer token",
    code: "UNAUTHENTICATED",
  });
});

test("CORS preflight permits fleet control headers", async () => {
  const response = await fetch(`${base}/api/v1/status`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://overseer.example.test",
      "Access-Control-Request-Method": "PATCH",
      "Access-Control-Request-Headers": "authorization,content-type,peon-actor,peon-protocol,peon-request-id",
    },
  });
  assert.equal(response.status, 204);
  const allowed = (response.headers.get("access-control-allow-headers") ?? "").toLowerCase();
  for (const header of ["authorization", "content-type", "peon-actor", "peon-protocol", "peon-request-id"]) {
    assert.ok(allowed.includes(header), `${header} missing from Access-Control-Allow-Headers`);
  }
});

test("malformed fleet JSON uses the stable API error envelope", async () => {
  const response = await fetch(`${base}/api/v1/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not-json",
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "request body must be valid JSON", code: "BAD_REQUEST" });
});

test("legacy and accidentally doubled API prefixes are not routed", async () => {
  const headers = { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" };
  assert.equal((await fetch(`${base}/agent/v1/status`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/v1/status`, { headers })).status, 404);
});

test("fleet session queue uses the same bearer profile, preserves actor, and unknown routes stay 404", async () => {
  const id = "7b07f0c5-7924-48a0-bbd6-a61a3f7cf611";
  sessions.start({ id, prompt: "keep running", dir: os.tmpdir() });
  sessions.enqueueSystem(id, "hidden completion trigger", "hidden-trigger");
  const headers = {
    Authorization: `Bearer ${token}`,
    "Peon-Protocol": "1",
    "Peon-Actor": "overseer-user",
    "Content-Type": "application/json",
  };

  const detail = await fetch(`${base}/api/v1/sessions/${id}`, { headers });
  assert.equal(detail.status, 200);
  const fleetDetail = await detail.json() as object;
  assert.equal(Object.hasOwn(fleetDetail, "pendingSystemPrompts"), false);
  assert.equal(Object.hasOwn(fleetDetail, "parentCompletionNotifiedAt"), false);
  assert.equal(Object.hasOwn(fleetDetail, "parentCompletionNotificationPending"), false);
  const humanDetail = await fetch(`${base}/api/v1/sessions/${id}`);
  assert.equal(humanDetail.status, 200);
  const localDetail = await humanDetail.json() as object;
  assert.equal(Object.hasOwn(localDetail, "pendingSystemPrompts"), false);
  assert.equal(Object.hasOwn(localDetail, "parentCompletionNotifiedAt"), false);
  assert.equal(Object.hasOwn(localDetail, "parentCompletionNotificationPending"), false);
  const empty = await fetch(`${base}/api/v1/sessions/${id}/queue`, { headers });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json(), { items: [] });

  const enqueued = await fetch(`${base}/api/v1/sessions/${id}/queue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "queued from Overseer", model: "sonnet", reasoningEffort: "high" }),
  });
  assert.equal(enqueued.status, 201);
  assert.equal(Object.hasOwn(await enqueued.clone().json() as object, "pendingSystemPrompts"), false);
  const listed = await fetch(`${base}/api/v1/sessions/${id}/queue`, { headers });
  const queue = (await listed.json()) as { items: Array<{ id: string; type: string; author: string; prompt: string }> };
  assert.equal(queue.items.length, 1);
  assert.equal(queue.items[0].type, "queue");
  assert.equal(queue.items[0].author, "overseer-user");
  assert.equal(queue.items[0].prompt, "queued from Overseer");

  const edited = await fetch(`${base}/api/v1/sessions/${id}/queue/${queue.items[0].id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ prompt: "edited from Overseer" }),
  });
  assert.equal(edited.status, 200);
  const editedRecord = (await edited.json()) as { queuedFollowUps: Array<{ id: string; prompt: string }> };
  assert.equal(editedRecord.queuedFollowUps.find((item) => item.id === queue.items[0].id)?.prompt, "edited from Overseer");

  const blankEdit = await fetch(`${base}/api/v1/sessions/${id}/queue/${queue.items[0].id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ prompt: "   " }),
  });
  assert.equal(blankEdit.status, 400);
  assert.deepEqual(await blankEdit.json(), { error: "prompt is required", code: "BAD_REQUEST" });

  const humanEdited = await fetch(`${base}/api/v1/sessions/${id}/queue/${queue.items[0].id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "edited locally" }),
  });
  assert.equal(humanEdited.status, 200);
  assert.equal(
    ((await humanEdited.json()) as { queuedFollowUps: Array<{ id: string; prompt: string }> })
      .queuedFollowUps.find((item) => item.id === queue.items[0].id)?.prompt,
    "edited locally",
  );

  const secondEnqueued = await fetch(`${base}/api/v1/sessions/${id}/queue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ prompt: "steer with this one" }),
  });
  assert.equal(secondEnqueued.status, 201);
  const queueWithSecond = (await secondEnqueued.json()) as { queuedFollowUps: Array<{ id: string; type: string; prompt: string }> };
  const selected = queueWithSecond.queuedFollowUps.find((item) => item.prompt === "steer with this one");
  assert.ok(selected);

  const steered = await fetch(`${base}/api/v1/sessions/${id}/queue/${selected.id}/steer`, { method: "POST", headers });
  assert.equal(steered.status, 200);
  assert.deepEqual(await steered.json(), { ok: true });
  assert.equal(sessions.get(id)?.queuedFollowUps.at(0)?.id, selected.id);
  assert.equal(sessions.get(id)?.queuedFollowUps.at(0)?.type, "steer");

  const unknownItem = await fetch(`${base}/api/v1/sessions/${id}/queue/not-an-item/send`, { method: "POST", headers });
  assert.equal(unknownItem.status, 404);
  assert.equal(unknownItem.headers.get("deprecation"), "true");
  assert.match(unknownItem.headers.get("link") ?? "", /\/steer/);
  assert.deepEqual(await unknownItem.json(), { error: "unknown queue item", code: "UNKNOWN_QUEUE_ITEM" });

  const humanUnknownItem = await fetch(`${base}/api/v1/sessions/${id}/queue/not-an-item/send`, { method: "POST" });
  assert.equal(humanUnknownItem.status, 404);
  assert.deepEqual(await humanUnknownItem.json(), { error: "unknown queue item" });

  const removed = await fetch(`${base}/api/v1/sessions/${id}/queue/${queue.items[0].id}`, { method: "DELETE", headers });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true });

  const unknown = await fetch(`${base}/api/v1/sessions/${id}/queue/not-an-item/extra`, { headers });
  assert.equal(unknown.status, 404);
  assert.deepEqual(await unknown.json(), { error: "not found", code: "NOT_FOUND" });
  sessions.cancel(id);
});

test("local SSE resumes from Last-Event-ID and validates replay boundaries before streaming", async () => {
  const id = "1cd64079-69aa-451c-bb74-b80f100fe13c";
  sessions.start({ id, prompt: "stream handoff", dir: os.tmpdir() });
  const boundary = sessions.getTranscriptEntries(id).at(-1)?.id;
  assert.ok(boundary);
  sessions.preview(id, "/tmp/missed.txt");

  const nextEvent = async (response: Response): Promise<{ id: string; data: Record<string, unknown> }> => {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundaryIndex;
      while ((boundaryIndex = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        if (!raw.includes("event: event")) continue;
        const eventId = raw.split("\n").find((line) => line.startsWith("id: "))?.slice(4);
        const data = raw.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        assert.ok(eventId && data);
        return { id: eventId, data: JSON.parse(data) as Record<string, unknown> };
      }
    }
  };

  const firstAbort = new AbortController();
  const streamUrl = `${base}/api/v1/sessions/${id}/stream?afterEventId=${encodeURIComponent(boundary)}`;
  const firstResponse = await fetch(streamUrl, { signal: firstAbort.signal });
  assert.equal(firstResponse.status, 200);
  const missed = await nextEvent(firstResponse);
  assert.equal(missed.data.name, "missed.txt");
  firstAbort.abort();

  sessions.preview(id, "/tmp/after-reconnect.txt");
  const secondAbort = new AbortController();
  const secondResponse = await fetch(streamUrl, {
    headers: { "Last-Event-ID": missed.id },
    signal: secondAbort.signal,
  });
  const resumed = await nextEvent(secondResponse);
  assert.equal(resumed.data.name, "after-reconnect.txt");
  secondAbort.abort();

  const invalid = await fetch(`${base}/api/v1/sessions/${id}/stream?afterEventId=${"x".repeat(300)}`);
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "invalid transcript event id", code: "BAD_CURSOR" });
  sessions.cancel(id);
});
