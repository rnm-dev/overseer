import assert from "node:assert/strict";
import test from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { setPool } from "./db.js";
import {
  AttachmentReceiptError,
  recordCommittedAttachmentReceipt,
} from "./modules/sessions/attachmentReceipts.js";

const WORKSPACE = "workspace-a";
const PEON = "123e4567-e89b-42d3-a456-426614174000";
const USER = "123e4567-e89b-42d3-a456-426614174001";
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
  return mem;
}

test("terminal write receipts remain stable for direct Fleet HTTP session requests", async () => {
  fixture();
  const input = {
    workspaceId: WORKSPACE,
    peonId: PEON,
    actor: { userId: USER, email: "operator@example.com" },
    transferId: TRANSFER,
    path: "uploads/draft/file.txt",
    size: 4,
    sha256: SHA,
    now: 1_000,
  };
  const first = await recordCommittedAttachmentReceipt(input);
  const replay = await recordCommittedAttachmentReceipt(input);
  assert.deepEqual(replay, first);
});

test("terminal write receipts reject malformed metadata", async () => {
  fixture();
  await assert.rejects(
    () => recordCommittedAttachmentReceipt({
      workspaceId: WORKSPACE,
      peonId: PEON,
      actor: { userId: USER, email: "operator@example.com" },
      transferId: "not-a-uuid",
      path: "uploads/draft/file.txt",
      size: 4,
      sha256: SHA,
    }),
    (error: unknown) => error instanceof AttachmentReceiptError && error.code === "INVALID_ATTACHMENT_RECEIPT",
  );
});
