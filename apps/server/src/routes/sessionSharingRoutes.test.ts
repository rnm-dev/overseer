import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { createServer } from "../app/server.js";
import { initDb, query } from "../infrastructure/db/index.js";
import { issueDevice } from "../modules/auth/index.js";
import { createSessionInvitation } from "../modules/sessions/index.js";

interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

function request(port: number, path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<HttpResponse> {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path,
      method,
      headers: {
        ...headers,
        ...(encoded ? { "content-type": "application/json", "content-length": String(Buffer.byteLength(encoded)) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: text ? JSON.parse(text) as Record<string, unknown> : {},
        });
      });
    });
    req.on("error", reject);
    req.end(encoded);
  });
}

test("public session capability routes preserve scoped credentials and attribution", async () => {
  const db = newDb();
  const pool = db.adapters.createPg().Pool;
  await initDb(new pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,github_login,created_at) VALUES
    ('owner','owner@example.test','owner',1),('invited','invited@example.test','authenticated-user',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ('ws','Shared','shared','owner',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('ws','owner','owner',1)`);
  await query(`INSERT INTO peons (peon_id,credential_id,workspace_id,name,address,control_port,capabilities,token,registered_at,last_seen)
    VALUES ('peon','credential','ws','Peon','127.0.0.1',4222,'[]','token',1,1)`);
  await query(`INSERT INTO sessions (peon_id,session_id,status,title,project_key,raw,synced_at)
    VALUES ('peon','session','active','Shared','shared','{}',1)`);

  const guestLink = await createSessionInvitation("ws", "peon", "session", "owner", {
    displayName: "Suggested Guest",
    accessMode: "participate",
    maxTurns: 2,
    maxDurationMs: 60 * 60 * 1_000,
    maxTokens: 0,
    expiresInMs: 60 * 60 * 1_000,
  });
  const ownerDevice = await issueDevice("owner", "test", { ip: null, userAgent: null });
  const invitedDevice = await issueDevice("invited", "test", { ip: null, userAgent: null });
  const server = http.createServer(createServer({ production: false }));
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
  try {
    const preview = await request(port, `/api/session-invitations/${encodeURIComponent(guestLink.token)}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body.alreadyAuthorized, false);
    assert.equal(preview.body.invitationId, undefined);

    const directPreview = await request(port, `/api/session-invitations/${encodeURIComponent(guestLink.token)}`, "GET", undefined, { authorization: `Bearer ${ownerDevice.token}` });
    assert.equal(directPreview.status, 200);
    assert.equal(directPreview.body.alreadyAuthorized, true);
    const directAcceptance = await request(port, `/api/session-invitations/${encodeURIComponent(guestLink.token)}`, "POST", {}, { authorization: `Bearer ${ownerDevice.token}` });
    assert.equal(directAcceptance.status, 201);
    assert.equal((directAcceptance.body.acceptance as Record<string, unknown>).alreadyAuthorized, true);

    const accepted = await request(port, `/api/session-invitations/${encodeURIComponent(guestLink.token)}`, "POST", { displayName: "Guest Visitor" });
    assert.equal(accepted.status, 201);
    const acceptance = accepted.body.acceptance as Record<string, unknown>;
    const participant = acceptance.participant as Record<string, unknown>;
    assert.equal((participant.identity as Record<string, unknown>).kind, "guest");
    assert.equal(participant.invitationId, undefined);
    assert.equal(acceptance.participantCredential, undefined);
    assert.match(accepted.headers["set-cookie"]?.[0] ?? "", /^__Host-overseer_session_participant=/u);
    assert.match(accepted.headers["set-cookie"]?.[0] ?? "", /HttpOnly/u);
    const participantId = participant.participantId;
    const cookie = accepted.headers["set-cookie"]![0]!.split(";", 1)[0]!;

    const resumed = await request(port, `/api/session-invitations/${encodeURIComponent(guestLink.token)}`, "POST", {}, { cookie });
    assert.equal(resumed.status, 201);
    assert.equal(((resumed.body.acceptance as Record<string, unknown>).participant as Record<string, unknown>).participantId, participantId);

    const authenticated = await request(
      port,
      `/api/session-invitations/${encodeURIComponent(guestLink.token)}`,
      "POST",
      { displayName: "not-the-user" },
      { authorization: `Bearer ${invitedDevice.token}` },
    );
    assert.equal(authenticated.status, 201);
    const authenticatedParticipant = (authenticated.body.acceptance as Record<string, unknown>).participant as Record<string, unknown>;
    assert.equal((authenticatedParticipant.identity as Record<string, unknown>).kind, "authenticated");
    assert.equal((authenticatedParticipant.identity as Record<string, unknown>).email, "invited@example.test");
    assert.equal(authenticatedParticipant.displayName, "authenticated-user");
    assert.equal(authenticatedParticipant.invitationId, undefined);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
