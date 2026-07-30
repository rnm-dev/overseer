import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, setPool, transaction } from "./db.js";
import {
  AttachmentReceiptError,
  bindAttachmentReceipts,
  recordCommittedAttachmentReceipt,
} from "./modules/sessions/attachmentReceipts.js";
import type { JsonObject } from "./modules/reverseCommands/reverseCommandTypes.js";
import { createOrGetReverseCommand } from "./modules/reverseCommands/reverseCommandRegistry.js";

const WORKSPACE = "workspace-a";
const PEON = "123e4567-e89b-42d3-a456-426614174000";
const USER = "123e4567-e89b-42d3-a456-426614174001";
const COMMAND = "123e4567-e89b-42d3-a456-426614174002";
const OTHER_COMMAND = "123e4567-e89b-42d3-a456-426614174003";
const TRANSFER = "123e4567-e89b-42d3-a456-426614174004";
const SHA = "a".repeat(64);

function fixture() {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  setPool(new adapter.Pool() as unknown as pg.Pool);
  mem.public.none(`CREATE TABLE attachment_transfer_receipts (
    receipt_id text primary key, workspace_id text not null, peon_id text not null,
    transfer_id text not null, actor_user_id text not null, actor_email text not null,
    path text not null, size bigint not null, sha256 text not null, created_at bigint not null,
    expires_at bigint not null, bound_command_id text, bound_request_hash text,
    bound_session_id text, bound_at bigint,
    unique(workspace_id, peon_id, transfer_id)
  )`);
  mem.public.none(`CREATE TABLE reverse_commands (
    workspace_id text not null, peon_id text not null, command_id text not null,
    primary key(workspace_id, peon_id, command_id)
  )`);
  return mem;
}

test("terminal write receipts bind idempotently to one durable command fingerprint", async () => {
  const mem = fixture();
  const receipt = await recordCommittedAttachmentReceipt({
    workspaceId: WORKSPACE,
    peonId: PEON,
    actor: { userId: USER, email: "operator@example.com" },
    transferId: TRANSFER,
    path: "uploads/draft/file.txt",
    size: 4,
    sha256: SHA,
    now: 1_000,
  });
  const bind = (commandId = COMMAND, requestHash = "request-a") => transaction((tx) =>
    bindAttachmentReceipts(tx, {
      workspaceId: WORKSPACE,
      peonId: PEON,
      commandId,
      requestHash,
      actor: { userId: USER, email: "operator@example.com" },
      payload: {
        prompt: "go",
        attachments: [{ type: "file", ...receipt }],
      },
      now: 1_001,
    }));
  await bind();
  await bind();
  await assert.rejects(() => bind(OTHER_COMMAND), (error: unknown) =>
    error instanceof AttachmentReceiptError && error.code === "ATTACHMENT_RECEIPT_CONFLICT");
  assert.equal(mem.public.many(`SELECT bound_command_id FROM attachment_transfer_receipts`)[0]?.bound_command_id, COMMAND);
});

test("attachment receipts fail closed across actor, metadata, expiry, and missing commit", async () => {
  fixture();
  const receipt = await recordCommittedAttachmentReceipt({
    workspaceId: WORKSPACE,
    peonId: PEON,
    actor: { userId: USER, email: "operator@example.com" },
    transferId: TRANSFER,
    path: "uploads/draft/file.txt",
    size: 4,
    sha256: SHA,
    now: 1_000,
  });
  const attempt = (attachment: Record<string, unknown>, userId = USER, now = 1_001) =>
    transaction((tx) => bindAttachmentReceipts(tx, {
      workspaceId: WORKSPACE,
      peonId: PEON,
      commandId: COMMAND,
      requestHash: "request-a",
      actor: { userId, email: "operator@example.com" },
      payload: { prompt: "go", attachments: [attachment as JsonObject] },
      now,
    }));
  await assert.rejects(() => attempt({ type: "file", path: receipt.path, size: receipt.size, sha256: receipt.sha256 }),
    (error: unknown) => error instanceof AttachmentReceiptError && error.code === "ATTACHMENT_NOT_COMMITTED");
  await assert.rejects(() => attempt({ type: "file", ...receipt, size: 5 }),
    (error: unknown) => error instanceof AttachmentReceiptError && error.code === "ATTACHMENT_RECEIPT_CONFLICT");
  await assert.rejects(() => attempt({ type: "file", ...receipt }, OTHER_COMMAND),
    (error: unknown) => error instanceof AttachmentReceiptError && error.code === "ATTACHMENT_RECEIPT_CONFLICT");
  await assert.rejects(() => attempt({ type: "file", ...receipt }, USER, 3_700_001),
    (error: unknown) => error instanceof AttachmentReceiptError && error.code === "ATTACHMENT_RECEIPT_CONFLICT");
  await assert.rejects(() => transaction((tx) => bindAttachmentReceipts(tx, {
    workspaceId: WORKSPACE,
    peonId: PEON,
    commandId: COMMAND,
    requestHash: "request-a",
    actor: { userId: USER, email: "operator@example.com" },
    payload: { attachments: [
      { type: "file", ...receipt },
      { type: "file", ...receipt },
    ] },
    now: 1_001,
  })), (error: unknown) =>
    error instanceof AttachmentReceiptError && error.code === "INVALID_ATTACHMENTS");
});

test("receipt binding and durable command creation commit atomically and survive registry restart", async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  const receipt = await recordCommittedAttachmentReceipt({
    workspaceId: WORKSPACE,
    peonId: PEON,
    actor: { userId: USER, email: "operator@example.com" },
    transferId: TRANSFER,
    path: "uploads/draft/file.txt",
    size: 4,
    sha256: SHA,
  });
  const payload: JsonObject = {
    prompt: "go",
    attachments: [{ type: "file", ...receipt }],
  };
  const command = {
    workspaceId: WORKSPACE,
    peonId: PEON,
    commandId: COMMAND,
    operation: "session.followup" as const,
    requestHash: "b".repeat(64),
    actor: { userId: USER, email: "operator@example.com" },
    target: { peonId: PEON, sessionId: "123e4567-e89b-42d3-a456-426614174005" },
    payload: {
      prompt: "go",
      attachments: [{ type: "file", path: receipt.path }],
    },
    attachmentPayload: payload,
    expected: null,
    requestBytes: 512,
    requestedAt: Date.now(),
  };
  assert.equal((await createOrGetReverseCommand(command)).kind, "created");
  assert.equal((await createOrGetReverseCommand(command)).kind, "existing");
  const stored = mem.public.one(`SELECT payload FROM reverse_commands WHERE command_id='${COMMAND}'`);
  assert.deepEqual(stored.payload, {
    prompt: "go",
    attachments: [{ type: "file", path: receipt.path }],
  }, "durable replay payload must not retain receipt capability metadata");
  await assert.rejects(() => createOrGetReverseCommand({
    ...command,
    commandId: OTHER_COMMAND,
    target: { ...command.target, sessionId: "123e4567-e89b-42d3-a456-426614174006" },
  }), (error: unknown) =>
    error instanceof AttachmentReceiptError && error.code === "ATTACHMENT_RECEIPT_CONFLICT");
});
