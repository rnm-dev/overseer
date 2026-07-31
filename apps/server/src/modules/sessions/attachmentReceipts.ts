import { randomUUID } from "node:crypto";
import { query } from "../../db.js";
import type { ReverseCommandActor } from "../reverseCommands/reverseCommandTypes.js";

const RECEIPT_TTL_MS = 60 * 60_000;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class AttachmentReceiptError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "AttachmentReceiptError";
  }
}

export interface CommittedAttachmentReceipt {
  transferId: string;
  path: string;
  size: number;
  sha256: string;
}

export async function recordCommittedAttachmentReceipt(input: {
  workspaceId: string;
  peonId: string;
  actor: ReverseCommandActor;
  transferId: string;
  path: string;
  size: number;
  sha256: string;
  now?: number;
}): Promise<CommittedAttachmentReceipt> {
  if (!UUID.test(input.transferId) || !input.path || input.path.length > 4_096
    || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_ATTACHMENT_BYTES
    || !SHA256.test(input.sha256)) {
    throw new AttachmentReceiptError("INVALID_ATTACHMENT_RECEIPT", "invalid committed attachment result");
  }
  const now = input.now ?? Date.now();
  const receiptId = randomUUID();
  await query(
    `DELETE FROM attachment_transfer_receipts
      WHERE bound_command_id IS NULL AND expires_at <= $1`,
    [now],
  );
  const { rows } = await query<CommittedAttachmentReceipt & { receipt_id: string }>(
    `INSERT INTO attachment_transfer_receipts
       (receipt_id,workspace_id,peon_id,transfer_id,actor_user_id,actor_email,path,size,sha256,created_at,expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (workspace_id,peon_id,transfer_id) DO UPDATE
       SET receipt_id=attachment_transfer_receipts.receipt_id
       WHERE attachment_transfer_receipts.actor_user_id=EXCLUDED.actor_user_id
         AND attachment_transfer_receipts.path=EXCLUDED.path
         AND attachment_transfer_receipts.size=EXCLUDED.size
         AND attachment_transfer_receipts.sha256=EXCLUDED.sha256
     RETURNING receipt_id,transfer_id,path,size,sha256`,
    [
      receiptId, input.workspaceId, input.peonId, input.transferId,
      input.actor.userId, input.actor.email, input.path, input.size, input.sha256,
      now, now + RECEIPT_TTL_MS,
    ],
  );
  const row = rows[0] as unknown as { receipt_id: string; transfer_id: string; path: string; size: number; sha256: string };
  if (!row) {
    throw new AttachmentReceiptError("TRANSFER_ID_REUSE", "attachment transfer ID was reused with different committed metadata");
  }
  return { transferId: row.receipt_id, path: row.path, size: Number(row.size), sha256: row.sha256 };
}
