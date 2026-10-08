import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Request } from "express";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "../../infrastructure/db/index.js";
import { heartbeatPresence, listHeartbeatPresence } from "../presence/index.js";
import type { AuthContext } from "../auth/index.js";
import { mergeSessionParticipantPresence, registerSessionSharingRoutes } from "../../routes/peons/sessionSharing.js";
import {
  acceptSessionInvitation,
  authorizeSessionParticipantRequest,
  createSessionInvitation,
  ensureDirectSessionParticipant,
  getSessionParticipantByCredential,
  getSessionInvitationPreview,
  hashSessionCapability,
  listSessionParticipants,
  revokeSessionInvitation,
  revokeSessionParticipant,
  participantScopedPath,
  participantSessionIdForRequest,
  sessionParticipantRequestAction,
} from "./index.js";

const owner: AuthContext = {
  userId: "owner",
  email: "owner@example.test",
  githubLogin: "owner",
  avatarUrl: null,
  deviceId: "owner-device",
};

const invited: AuthContext = {
  userId: "invited",
  email: "invited@example.test",
  githubLogin: "real-operator",
  avatarUrl: null,
  deviceId: "invited-device",
};

function request(method: string, path: string, params: Record<string, string>, headers: Record<string, string> = {}, body: unknown = {}): Request {
  return { method, path, params, headers, body, query: {} } as unknown as Request;
}

async function setup(): Promise<void> {
  const db = newDb();
  const pool = db.adapters.createPg().Pool;
  await initDb(new pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,github_login,created_at) VALUES
    ('owner','owner@example.test','owner',1),
    ('invited','invited@example.test','real-operator',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_by,created_at) VALUES ('ws','Shared','shared','owner',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('ws','owner','owner',1)`);
  await query(`INSERT INTO peons (peon_id,credential_id,workspace_id,name,address,control_port,capabilities,token,registered_at,last_seen)
    VALUES ('peon','credential','ws','Peon','127.0.0.1',4222,'[]','token',1,1)`);
  await query(`INSERT INTO sessions (peon_id,session_id,status,title,project_key,raw,synced_at)
    VALUES ('peon','session','active','Canonical conversation','shared','{}',1)`);
}

function invitationInput(overrides: Record<string, unknown> = {}) {
  return {
    displayName: "Alex",
    accessMode: "participate",
    maxTurns: 2,
    maxDurationMs: 60 * 60 * 1_000,
    maxTokens: 0,
    expiresInMs: 60 * 60 * 1_000,
    ...overrides,
  };
}

test("migration normalizes sharing rows, hashes capabilities, and enforces local invariants", async () => {
  await setup();
  const migration = await query<{ id: string }>(`SELECT id FROM schema_migrations WHERE id='040_session_sharing'`);
  assert.equal(migration.rows.length, 1);

  const created = await createSessionInvitation("ws", "peon", "session", "owner", invitationInput());
  const stored = await query<{ token_hash: string }>(`SELECT token_hash FROM session_invitations WHERE id=$1`, [created.invitation.id]);
  assert.equal(stored.rows[0]?.token_hash, hashSessionCapability(created.token));
  assert.notEqual(stored.rows[0]?.token_hash, created.token);
  assert.equal((await query(`SELECT 1 FROM session_invitations WHERE token_hash=$1 AND token_hash=$2`, [created.token, created.token])).rows.length, 0);

  await assert.rejects(
    query(`INSERT INTO session_invitations
      (id,workspace_id,peon_id,session_id,token_hash,display_name,access_mode,max_turns,max_duration_ms,max_tokens,created_by,created_at,expires_at)
      VALUES ('bad','ws','peon','session','bad-hash','Guest','admin',1,1,0,'owner',1,2)`),
  );
  await assert.rejects(
    query(`INSERT INTO session_invitations
      (id,workspace_id,peon_id,session_id,token_hash,display_name,access_mode,max_turns,max_duration_ms,max_tokens,created_by,created_at,expires_at)
      VALUES ('bad-fk','missing','peon','session','bad-hash-2','Guest','read',1,1,0,'owner',1,2)`),
  );
  await assert.rejects(
    query(`INSERT INTO session_participants
      (id,workspace_id,peon_id,session_id,invitation_id,guest_id,display_name,access_mode,provenance,joined_at,last_active_at,expires_at)
      VALUES ('bad-participant-scope','ws','peon','another-session',$1,'guest_bad','Guest','read','invitation',1,1,2)`, [created.invitation.id]),
  );
});

test("guest admission is durable, scoped, and keeps the guest actor across reuse", async () => {
  await setup();
  const created = await createSessionInvitation("ws", "peon", "session", "owner", invitationInput({ displayName: "Suggested name" }));
  const first = await acceptSessionInvitation(created.token, null, "  Ada\nLovelace  ", "");
  assert.equal(first.alreadyAuthorized, false);
  assert.equal(first.participant?.identity.kind, "guest");
  assert.equal(first.participant?.displayName, "Ada Lovelace");
  assert.match(first.participant?.identity.guestId ?? "", /^guest_/u);
  assert.match(first.participant?.identity.displayName ?? "", /Ada/u);
  assert.ok(first.participantCredential);

  const admitted = await getSessionParticipantByCredential(first.participantCredential!.token);
  assert.equal(admitted?.sessionId, "session");
  assert.equal(admitted?.actor, "Guest · Ada Lovelace");
  const reused = await acceptSessionInvitation(created.token, null, "Ada Updated", first.participantCredential!.token);
  assert.equal(reused.participant?.participantId, first.participant?.participantId);
  assert.equal(reused.participant?.displayName, "Ada Updated");

  const otherSession = request("GET", "/workspaces/ws/peons/peon/sessions/other/transcript", { sid: "other" });
  await assert.rejects(authorizeSessionParticipantRequest(admitted!, otherSession), (error: unknown) =>
    error instanceof Error && "code" in error && (error as { code: string }).code === "PARTICIPANT_SCOPE");
});

test("authenticated invitation attribution is distinct from direct access and limits", async () => {
  await setup();
  const invitedLink = await createSessionInvitation("ws", "peon", "session", "owner", invitationInput({ displayName: "Suggested Guest" }));
  const accepted = await acceptSessionInvitation(invitedLink.token, invited, "ignored", "");
  assert.equal(accepted.alreadyAuthorized, false);
  assert.equal(accepted.participant?.identity.kind, "authenticated");
  assert.equal(accepted.participant?.displayName, "real-operator");
  assert.equal(accepted.participant?.identity.email, invited.email);
  assert.equal(accepted.participant?.provenance, "invitation");
  assert.notEqual(accepted.participant?.displayName, "Suggested Guest");

  const directLink = await createSessionInvitation("ws", "peon", "session", "owner", invitationInput());
  const direct = await acceptSessionInvitation(directLink.token, owner, "ignored", "");
  assert.equal(direct.alreadyAuthorized, true);
  assert.equal((await query(`SELECT 1 FROM session_participants WHERE invitation_id=$1`, [directLink.invitation.id])).rows.length, 0);
  assert.equal((await getSessionInvitationPreview(directLink.token, owner))?.alreadyAuthorized, true);
  assert.equal(await revokeSessionInvitation("ws", "peon", "session", directLink.invitation.id), true);
  assert.equal((await getSessionInvitationPreview(directLink.token, owner))?.alreadyAuthorized, true);
  assert.equal((await acceptSessionInvitation(directLink.token, owner, "ignored", "")).alreadyAuthorized, true);
});

test("read/participate matrix and turn admission are conservative and idempotent", async () => {
  await setup();
  const readLink = await createSessionInvitation("ws", "peon", "session", "owner", invitationInput({ accessMode: "read" }));
  const readAcceptance = await acceptSessionInvitation(readLink.token, null, "Reader", "");
  const reader = await getSessionParticipantByCredential(readAcceptance.participantCredential!.token);
  assert.equal(sessionParticipantRequestAction(request("GET", "/workspaces/ws/peons/peon/sessions/session/transcript", { sid: "session" })), "read");
  assert.equal(sessionParticipantRequestAction(request("GET", "/workspaces/ws/peons/peon/sessions/session/pins", { sid: "session" })), "read");
  await authorizeSessionParticipantRequest(reader!, request("GET", "/workspaces/ws/peons/peon/sessions/session/pins", { sid: "session" }));
  for (const method of ["PUT", "DELETE"]) {
    await assert.rejects(authorizeSessionParticipantRequest(reader!, request(method, "/workspaces/ws/peons/peon/sessions/session/pins/e1", { sid: "session" })), /read-only/);
  }

  assert.equal(sessionParticipantRequestAction(request("GET", "/workspaces/ws/peons/peon/sessions/session", { sid: "session" })), "participate");
  assert.equal(sessionParticipantRequestAction(request("POST", "/workspaces/ws/peons/peon/sessions/session/followup", { sid: "session" })), "turn");
  assert.equal(participantScopedPath("/workspaces/ws/peons/peon/files/uploads/session/report.txt"), true);
  assert.equal(participantSessionIdForRequest(request("PUT", "/workspaces/ws/peons/peon/files/uploads/session/report.txt", {})), "session");
  assert.equal(participantSessionIdForRequest(request("GET", "/workspaces/ws/peons/peon/attachments", {}, {}, undefined)), null);
  assert.equal(sessionParticipantRequestAction(request("GET", "/workspaces/ws/peons/peon/files/uploads/other/report.txt", {})), "participate");
  await assert.rejects(
    authorizeSessionParticipantRequest(reader!, request("POST", "/workspaces/ws/peons/peon/sessions/session/followup", { sid: "session" }, { "peon-request-id": "read-turn" })),
    (error: unknown) => error instanceof Error && "code" in error && (error as { code: string }).code === "PARTICIPANT_READ_ONLY",
  );

  const turnLink = await createSessionInvitation("ws", "peon", "session", "owner", invitationInput({ maxTurns: 1, accessMode: "participate" }));
  const turnAcceptance = await acceptSessionInvitation(turnLink.token, null, "Writer", "");
  const writer = await getSessionParticipantByCredential(turnAcceptance.participantCredential!.token);
  const followup = (id: string) => request("POST", "/workspaces/ws/peons/peon/sessions/session/followup", { sid: "session" }, { "peon-request-id": id });
  assert.deepEqual(await authorizeSessionParticipantRequest(writer!, followup("command-1")), { action: "turn", commandId: "command-1", reserved: true });
  assert.deepEqual(await authorizeSessionParticipantRequest(writer!, followup("command-1")), { action: "turn", commandId: "command-1", reserved: false });
  await assert.rejects(authorizeSessionParticipantRequest(writer!, followup("command-2")), (error: unknown) =>
    error instanceof Error && "code" in error && (error as { code: string }).code === "PARTICIPANT_LIMIT_EXHAUSTED");
  const usage = await query<{ turns_used: number }>(`SELECT turns_used FROM session_participants WHERE id=$1`, [writer!.participantId]);
  assert.equal(usage.rows[0]?.turns_used, 1);
});

test("invitation revocation does not revoke admitted access, while participant revocation does", async () => {
  await setup();
  const created = await createSessionInvitation("ws", "peon", "session", "owner", invitationInput());
  const accepted = await acceptSessionInvitation(created.token, null, "Reader", "");
  const credential = accepted.participantCredential!.token;
  assert.equal(await revokeSessionInvitation("ws", "peon", "session", created.invitation.id), true);
  const stillAdmitted = await getSessionParticipantByCredential(credential);
  assert.ok(stillAdmitted);
  const resumed = await acceptSessionInvitation(created.token, null, undefined, credential);
  assert.equal(resumed.participant?.participantId, accepted.participant?.participantId);
  await assert.rejects(acceptSessionInvitation(created.token, null, "New guest", ""), (error: unknown) =>
    error instanceof Error && "code" in error && (error as { code: string }).code === "INVITATION_REVOKED");
  assert.equal(await revokeSessionParticipant("ws", "peon", "session", accepted.participant!.participantId), true);
  assert.equal(await getSessionParticipantByCredential(credential), null);

  await ensureDirectSessionParticipant("ws", "peon", "session", owner);
  const direct = (await listSessionParticipants("ws", "peon", "session")).find((participant) => participant.provenance === "direct");
  assert.ok(direct);
  assert.equal(await revokeSessionParticipant("ws", "peon", "session", direct!.participantId), false);
});

test("participant roster keeps identity and presence separate from durable access", async () => {
  await setup();
  const created = await createSessionInvitation("ws", "peon", "session", "owner", invitationInput());
  const accepted = await acceptSessionInvitation(created.token, null, "Guest Name", "");
  const guest = accepted.participant!;
  const before = await listSessionParticipants("ws", "peon", "session");
  assert.equal(before.find((item) => item.participantId === guest.participantId)?.presence.status, "offline");
  heartbeatPresence({
    workspaceId: "ws",
    connectionId: "guest-connection",
    userId: guest.identity.guestId!,
    email: "",
    githubLogin: null,
    avatarUrl: null,
    scope: "session",
    peonId: "peon",
    sessionId: "session",
    projectKey: "shared",
    projectId: null,
    active: true,
    participantId: guest.participantId,
  });
  const shaped = mergeSessionParticipantPresence(
    await listSessionParticipants("ws", "peon", "session"),
    listHeartbeatPresence("ws").filter((entry) => entry.peonId === "peon" && entry.sessionId === "session"),
  )[0];
  assert.equal(shaped?.identity.kind, "guest");
  assert.equal(shaped?.presence.status, "online");
  assert.equal(shaped?.status, "active");
  assert.equal(shaped?.usage.quality, "unknown");
});

test("session sharing registers only the canonical management routes", () => {
  const router = express.Router();
  registerSessionSharingRoutes(router);
  const stack = (router as unknown as {
    stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }>;
  }).stack;
  const routes = stack.flatMap((layer) => layer.route ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`) : []);
  assert.ok(routes.includes("GET /workspaces/:wsId/peons/:peonId/sessions/:sid/invitations"));
  assert.ok(routes.includes("POST /workspaces/:wsId/peons/:peonId/sessions/:sid/invitations"));
  assert.ok(routes.includes("GET /workspaces/:wsId/peons/:peonId/sessions/:sid/invitations/:invitationId"));
  assert.ok(routes.includes("PATCH /workspaces/:wsId/peons/:peonId/sessions/:sid/invitations/:invitationId"));
  assert.ok(routes.includes("DELETE /workspaces/:wsId/peons/:peonId/sessions/:sid/invitations/:invitationId"));
  assert.ok(routes.includes("GET /workspaces/:wsId/peons/:peonId/sessions/:sid/participants"));
  assert.ok(routes.includes("DELETE /workspaces/:wsId/peons/:peonId/sessions/:sid/participants/:participantId"));
  assert.equal(routes.some((route) => route.includes("/public/") || route.includes("/public")), false);
});
