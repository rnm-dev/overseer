import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { replaceMemberAccess } from "../../modules/access/index.js";
import { initDb, query } from "../../infrastructure/db/index.js";
import { issueDevice } from "../../modules/auth/index.js";
import { registry } from "../../modules/fleet/index.js";
import { createServer } from "../../app/server.js";

const CAPABILITY = "armory-project-packages-v1";
const PROFILE_ID = "57ba5e9e-3ed2-4a92-919f-9f60ee69a450";
const STALE_PROFILE_ID = "57ba5e9e-3ed2-4a92-919f-9f60ee69a451";
const PROJECT_ID = "87b68e30-a923-48b4-9a58-f561a2390083";
const HIDDEN_PROJECT_ID = "87b68e30-a923-48b4-9a58-f561a2390084";
const STALE_PROJECT_ID = "87b68e30-a923-48b4-9a58-f561a2390085";
const OPERATION_ID = "f09663fc-fc80-4314-a7e6-70b14dd29473";
const SECRET = "profile_value_that_must_never_escape";

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  actor: string | undefined;
  requestId: string | undefined;
  body: unknown;
}

interface AppFixture {
  port: number;
  workspaceId: string;
  otherWorkspaceId: string;
  ownerToken: string;
  memberToken: string;
  otherOwnerToken: string;
  seen: SeenRequest[];
}

let fixture: AppFixture;
const servers: http.Server[] = [];

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function peonServer(seen: SeenRequest[]): http.Server {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) as unknown : null;
      const url = req.url ?? "";
      seen.push({
        method: req.method ?? "GET",
        url,
        authorization: req.headers.authorization,
        actor: req.headers["peon-actor"] as string | undefined,
        requestId: req.headers["peon-request-id"] as string | undefined,
        body,
      });

      if (req.method === "GET" && url === "/api/v1/armory/profiles") {
        return sendJson(res, 200, { profiles: [{
          profileId: PROFILE_ID,
          type: "google-service-account",
          name: "Shared Google",
          status: "verified",
          configuredFields: { serviceAccountJson: true },
          values: { serviceAccountJson: SECRET },
        }] });
      }
      if (req.method === "POST" && url === "/api/v1/armory/profiles") {
        return sendJson(res, 201, {
          profileId: PROFILE_ID,
          type: "google-service-account",
          name: "Shared Google",
          status: "missing",
          configuredFields: {},
        });
      }
      if (req.method === "PATCH" && url === `/api/v1/armory/profiles/${PROFILE_ID}`) {
        return sendJson(res, 200, {
          profileId: PROFILE_ID,
          type: "google-service-account",
          name: "Renamed Google",
          status: "verified",
          configuredFields: { serviceAccountJson: true },
        });
      }
      if (req.method === "DELETE" && url === `/api/v1/armory/profiles/${PROFILE_ID}`) {
        return sendJson(res, 409, { code: "PROFILE_IN_USE", error: `Profile ${SECRET} is assigned`, diagnostics: SECRET });
      }
      if (req.method === "PUT" && url === `/api/v1/armory/profiles/${PROFILE_ID}/configuration`) {
        return sendJson(res, 202, { operationId: OPERATION_ID, kind: "profile_configure", status: "queued", code: null, diagnostics: SECRET });
      }
      if (req.method === "PUT" && url === `/api/v1/armory/profiles/${STALE_PROFILE_ID}/configuration`) {
        return sendJson(res, 404, { code: "PROFILE_NOT_FOUND", error: `Unknown ${SECRET}`, diagnostics: SECRET });
      }
      if (req.method === "POST" && url === `/api/v1/armory/profiles/${PROFILE_ID}/verify`) {
        return sendJson(res, 202, { operationId: OPERATION_ID, kind: "profile_verify", status: "queued", code: null });
      }
      if (req.method === "GET" && url === `/api/v1/armory/operations/${OPERATION_ID}`) {
        return sendJson(res, 200, { operation: {
          operationId: OPERATION_ID,
          kind: "profile_configure",
          status: "failed",
          code: "PROFILE_NOT_VERIFIED",
          diagnostics: SECRET,
        } });
      }
      if (req.method === "GET" && url === `/api/v1/armory/projects/${PROJECT_ID}/assignments`) {
        return sendJson(res, 200, { assignments: [{ projectId: PROJECT_ID, packageId: "google-drive", profileId: PROFILE_ID, values: SECRET }] });
      }
      if (req.method === "GET" && url === `/api/v1/armory/projects/${STALE_PROJECT_ID}/assignments`) {
        return sendJson(res, 404, { code: "PROJECT_NOT_FOUND", error: "Project no longer exists" });
      }
      if (req.method === "PUT" && url === `/api/v1/armory/projects/${PROJECT_ID}/assignments/google-drive`) {
        if ((body as { profileId?: unknown })?.profileId === STALE_PROFILE_ID) {
          return sendJson(res, 404, { code: "PROFILE_NOT_FOUND", error: "Profile no longer exists" });
        }
        return sendJson(res, 200, { projectId: PROJECT_ID, packageId: "google-drive", profileId: PROFILE_ID });
      }
      if (req.method === "DELETE" && url === `/api/v1/armory/projects/${PROJECT_ID}/assignments/google-drive`) {
        return sendJson(res, 200, { projectId: PROJECT_ID, packageId: "google-drive", profileId: PROFILE_ID });
      }
      if (req.method === "POST" && (url === "/api/v1/armory/packages/legacy-package/enable" || url === "/api/v1/armory/packages/legacy-package/disable")) {
        return sendJson(res, 202, { operation: { id: OPERATION_ID, kind: "enable", status: "queued" } });
      }
      return sendJson(res, 404, { code: "NOT_FOUND", error: "not found" });
    });
  });
}

async function registerPeon(input: {
  peonId: string;
  workspaceId: string;
  port: number;
  capabilities: string[];
  token: string;
}): Promise<void> {
  await registry.register({
    peonId: input.peonId,
    credentialId: `cred-${input.peonId}`,
    workspaceId: input.workspaceId,
    name: input.peonId,
    hostname: null,
    address: "127.0.0.1",
    controlPort: input.port,
    protocol: 1,
    capabilities: input.capabilities,
    token: input.token,
    load: null,
  });
}

before(async () => {
  const mem = newDb();
  const Pool = mem.adapters.createPg().Pool;
  await initDb(new Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES
    ('owner','owner@example.test',1),('member','member@example.test',1),('other-owner','other@example.test',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES
    ('armory-ws','Armory','armory','owner',1),('other-ws','Other','other','other-owner',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES
    ('armory-ws','owner','owner',1),('armory-ws','member','member',1),('other-ws','other-owner','owner',1)`);
  const [owner, member, otherOwner] = await Promise.all([
    issueDevice("owner", "test", { ip: null, userAgent: null }),
    issueDevice("member", "test", { ip: null, userAgent: null }),
    issueDevice("other-owner", "test", { ip: null, userAgent: null }),
  ]);
  const seen: SeenRequest[] = [];
  const peonPort = await listen(peonServer(seen));
  await registerPeon({ peonId: "capable", workspaceId: "armory-ws", port: peonPort, capabilities: [CAPABILITY], token: "capable-token" });
  await registerPeon({ peonId: "legacy", workspaceId: "armory-ws", port: peonPort, capabilities: [], token: "legacy-token" });
  await registerPeon({ peonId: "other", workspaceId: "other-ws", port: peonPort, capabilities: [CAPABILITY], token: "other-token" });
  await replaceMemberAccess("armory-ws", "member", {
    peonIds: ["capable"],
    projects: [{ peonId: "capable", projectKey: "renamed-project", projectId: PROJECT_ID }],
  }, "owner");
  fixture = {
    port: await listen(http.createServer(createServer())),
    workspaceId: "armory-ws",
    otherWorkspaceId: "other-ws",
    ownerToken: owner.token,
    memberToken: member.token,
    otherOwnerToken: otherOwner.token,
    seen,
  };
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function api(input: {
  path: string;
  token?: string;
  method?: string;
  body?: unknown;
  requestId?: string;
  actor?: string;
}): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const response = await fetch(`http://127.0.0.1:${fixture.port}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      ...(input.token ? { Authorization: `Bearer ${input.token}` } : {}),
      ...(input.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(input.requestId ? { "Peon-Request-Id": input.requestId } : {}),
      ...(input.actor ? { "X-Actor": input.actor } : {}),
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {}, text };
}

function root(peonId = "capable", workspaceId = fixture.workspaceId): string {
  return `/api/workspaces/${workspaceId}/peons/${peonId}/armory`;
}

test("typed Armory resources require authentication, workspace membership, and Peon ACLs", async () => {
  assert.equal((await api({ path: `${root()}/profiles` })).status, 401);
  assert.equal((await api({ path: `${root()}/profiles`, token: fixture.otherOwnerToken })).status, 404);
  assert.equal((await api({ path: `${root("other", fixture.otherWorkspaceId)}/profiles`, token: fixture.ownerToken })).status, 404);
  assert.equal((await api({ path: `${root("legacy")}/profiles`, token: fixture.memberToken })).status, 404);
  const allowed = await api({ path: `${root()}/profiles`, token: fixture.memberToken });
  assert.equal(allowed.status, 200);
  assert.doesNotMatch(allowed.text, new RegExp(SECRET));
  assert.deepEqual(allowed.body, { profiles: [{
    profileId: PROFILE_ID,
    type: "google-service-account",
    name: "Shared Google",
    status: "verified",
    configuredFields: { serviceAccountJson: true },
  }] });
});

test("older Peons get stable unsupported behavior and capable Peons never invoke legacy activation", async () => {
  const beforeUnsupported = fixture.seen.length;
  const unsupported = await api({ path: `${root("legacy")}/profiles`, token: fixture.ownerToken });
  assert.deepEqual([unsupported.status, unsupported.body.code], [409, "UNSUPPORTED_CAPABILITY"]);
  assert.equal(fixture.seen.length, beforeUnsupported);

  const beforeRetired = fixture.seen.length;
  const retired = await api({ path: `${root()}/packages/legacy-package/enable`, method: "POST", token: fixture.ownerToken });
  assert.deepEqual([retired.status, retired.body.code], [410, "ARMORY_ACTIVATION_RETIRED"]);
  assert.equal(fixture.seen.length, beforeRetired);

  const legacy = await api({
    path: `${root("legacy")}/packages/legacy-package/enable`,
    method: "POST",
    token: fixture.ownerToken,
    requestId: "legacy-request-id",
  });
  assert.equal(legacy.status, 202);
  const relayed = fixture.seen.at(-1)!;
  assert.equal(relayed.url, "/api/v1/armory/packages/legacy-package/enable");
  assert.equal(relayed.requestId, "legacy-request-id");
});

test("profile CRUD/configure/verify relays canonical actor and stable request IDs without returning values", async () => {
  const created = await api({
    path: `${root()}/profiles`,
    method: "POST",
    token: fixture.ownerToken,
    requestId: "create-profile-request",
    actor: "attacker@example.test",
    body: { type: "google-service-account", name: " Shared Google " },
  });
  assert.equal(created.status, 201);
  const createRequest = fixture.seen.at(-1)!;
  assert.equal(createRequest.actor, "owner@example.test");
  assert.equal(createRequest.requestId, "create-profile-request");
  assert.deepEqual(createRequest.body, { type: "google-service-account", name: "Shared Google" });
  assert.equal(createRequest.authorization, "Bearer capable-token");

  const renamed = await api({
    path: `${root()}/profiles/${PROFILE_ID}`,
    method: "PATCH",
    token: fixture.ownerToken,
    requestId: "rename-profile-request",
    body: { name: "Renamed Google" },
  });
  assert.equal(renamed.status, 200);
  assert.equal(fixture.seen.at(-1)?.requestId, "rename-profile-request");

  const configured = await api({
    path: `${root()}/profiles/${PROFILE_ID}/configuration`,
    method: "PUT",
    token: fixture.ownerToken,
    requestId: "configure-profile-request",
    body: { values: { serviceAccountJson: SECRET } },
  });
  assert.equal(configured.status, 202);
  assert.doesNotMatch(configured.text, new RegExp(SECRET));
  assert.deepEqual(configured.body, { operationId: OPERATION_ID, kind: "profile_configure", status: "queued", code: null });
  const configureRequest = fixture.seen.at(-1)!;
  assert.equal(configureRequest.requestId, "configure-profile-request");
  assert.deepEqual(configureRequest.body, { values: { serviceAccountJson: SECRET } });

  const staleConfiguration = await api({
    path: `${root()}/profiles/${STALE_PROFILE_ID}/configuration`,
    method: "PUT",
    token: fixture.ownerToken,
    body: { values: { serviceAccountJson: SECRET } },
  });
  assert.deepEqual([staleConfiguration.status, staleConfiguration.body.code], [404, "PROFILE_NOT_FOUND"]);
  assert.doesNotMatch(staleConfiguration.text, new RegExp(SECRET));

  const verified = await api({
    path: `${root()}/profiles/${PROFILE_ID}/verify`,
    method: "POST",
    token: fixture.ownerToken,
    requestId: "verify-profile-request",
  });
  assert.equal(verified.status, 202);
  assert.equal(fixture.seen.at(-1)?.requestId, "verify-profile-request");

  const deletion = await api({
    path: `${root()}/profiles/${PROFILE_ID}`,
    method: "DELETE",
    token: fixture.ownerToken,
    requestId: "delete-profile-request",
  });
  assert.deepEqual([deletion.status, deletion.body.code], [409, "PROFILE_IN_USE"]);
  assert.doesNotMatch(deletion.text, new RegExp(SECRET));
  assert.equal(fixture.seen.at(-1)?.requestId, "delete-profile-request");
});

test("assignment routes enforce immutable-project ACLs before relaying and preserve stale-reference codes", async () => {
  const beforeHidden = fixture.seen.length;
  const hidden = await api({
    path: `${root()}/projects/${HIDDEN_PROJECT_ID}/assignments`,
    token: fixture.memberToken,
  });
  assert.deepEqual([hidden.status, hidden.body.code], [404, "UNKNOWN_PROJECT"]);
  assert.equal(fixture.seen.length, beforeHidden);

  const listed = await api({ path: `${root()}/projects/${PROJECT_ID}/assignments`, token: fixture.memberToken });
  assert.equal(listed.status, 200);
  assert.doesNotMatch(listed.text, new RegExp(SECRET));
  assert.deepEqual(listed.body, { assignments: [{ projectId: PROJECT_ID, packageId: "google-drive", profileId: PROFILE_ID }] });

  const set = await api({
    path: `${root()}/projects/${PROJECT_ID}/assignments/google-drive`,
    method: "PUT",
    token: fixture.memberToken,
    requestId: "set-assignment-request",
    body: { profileId: PROFILE_ID },
  });
  assert.equal(set.status, 200);
  assert.equal(fixture.seen.at(-1)?.requestId, "set-assignment-request");

  const staleProfile = await api({
    path: `${root()}/projects/${PROJECT_ID}/assignments/google-drive`,
    method: "PUT",
    token: fixture.memberToken,
    body: { profileId: STALE_PROFILE_ID },
  });
  assert.deepEqual([staleProfile.status, staleProfile.body.code], [404, "PROFILE_NOT_FOUND"]);

  const staleProject = await api({
    path: `${root()}/projects/${STALE_PROJECT_ID}/assignments`,
    token: fixture.ownerToken,
  });
  assert.deepEqual([staleProject.status, staleProject.body.code], [404, "PROJECT_NOT_FOUND"]);

  const removed = await api({
    path: `${root()}/projects/${PROJECT_ID}/assignments/google-drive`,
    method: "DELETE",
    token: fixture.memberToken,
    requestId: "remove-assignment-request",
  });
  assert.equal(removed.status, 200);
  assert.equal(fixture.seen.at(-1)?.requestId, "remove-assignment-request");
});

test("identifier and body validation is bounded, strict, and does not relay diagnostics", async () => {
  const tooManyFields = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, "value"]));
  for (const request of [
    { path: `${root()}/profiles/not-a-uuid`, method: "PATCH", body: { name: "Name" } },
    { path: `${root()}/profiles`, method: "POST", body: { type: "Invalid Type", name: "Name" } },
    { path: `${root()}/profiles`, method: "POST", body: { type: "type", name: "x".repeat(81) } },
    { path: `${root()}/profiles`, method: "POST", body: { type: "type", name: "Name", values: SECRET } },
    { path: `${root()}/profiles/${PROFILE_ID}/configuration`, method: "PUT", body: { values: { "bad-field": SECRET } } },
    { path: `${root()}/profiles/${PROFILE_ID}/configuration`, method: "PUT", body: { values: tooManyFields } },
    { path: `${root()}/projects/${PROJECT_ID}/assignments/Bad!`, method: "PUT", body: { profileId: null } },
    { path: `${root()}/projects/${PROJECT_ID}/assignments/google-drive`, method: "PUT", body: { profileId: "stale", diagnostics: SECRET } },
  ]) {
    const before = fixture.seen.length;
    const response = await api({ ...request, token: fixture.ownerToken });
    assert.deepEqual([response.status, response.body.code], [400, "BAD_REQUEST"]);
    assert.doesNotMatch(response.text, new RegExp(SECRET));
    assert.equal(fixture.seen.length, before);
  }
});

test("profile operation polling uses the existing durable operation route and removes diagnostics", async () => {
  const response = await api({ path: `${root()}/operations/${OPERATION_ID}`, token: fixture.ownerToken });
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, new RegExp(SECRET));
  assert.deepEqual(response.body, { operation: {
    operationId: OPERATION_ID,
    kind: "profile_configure",
    status: "failed",
    code: "PROFILE_NOT_VERIFIED",
  } });
});
