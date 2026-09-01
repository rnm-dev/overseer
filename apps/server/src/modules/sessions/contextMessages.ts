import { appendEvent } from "../../infrastructure/events/index.js";
import { randomUUID } from "node:crypto";
import { query } from "../../infrastructure/db/index.js";
import type { SessionParticipantAuth } from "./sessionSharingTypes.js";
import { listSessionParticipants } from "./sessionSharing.js";

export const CONTEXT_MESSAGES_CAPABILITY = "context-only-messages-v1";

export interface MentionPrincipalRef { kind: "user" | "guest"; id: string }
export interface MentionPrincipal extends MentionPrincipalRef { label: string }
export interface MentionInput { startUtf16: number; lengthUtf16: number; principal: MentionPrincipalRef }
export interface NormalizedMention { startUtf16: number; lengthUtf16: number; principal: MentionPrincipal }
export interface MentionAttentionPayload {
  peonId: string;
  sessionId: string;
  eventId: string;
  recipient: MentionPrincipalRef;
  unread: boolean;
  updatedAt: number;
}

export class ContextMessageError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = "ContextMessageError";
  }
}

const opaqueId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const eventIdPattern = /^[A-Za-z0-9_-]{1,256}$/u;
const commandIdPattern = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/u;

export function validContextCommandId(value: unknown): value is string {
  return typeof value === "string" && commandIdPattern.test(value);
}

function principalLabel(value: string): string {
  return value.slice(0, 80);
}

function boundarySplitsSurrogate(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false;
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}

export function validateContextText(value: unknown): string {
  if (typeof value !== "string" || !/\S/u.test(value)) {
    throw new ContextMessageError("context message text is required", "BAD_CONTEXT_MESSAGE", 400);
  }
  if ([...value].length > 8192 || Buffer.byteLength(value, "utf8") > 16 * 1024) {
    throw new ContextMessageError("context message text exceeds its bound", "BAD_CONTEXT_MESSAGE", 400);
  }
  return value;
}

export function validateMentionInputs(text: string, value: unknown, nullable = false): MentionInput[] | null {
  if (value === null && nullable) return null;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new ContextMessageError("mentions are invalid", "BAD_MENTION", 400);
  let previousEnd = 0;
  return value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ContextMessageError("mention is invalid", "BAD_MENTION", 400);
    const mention = raw as Record<string, unknown>;
    const principal = mention.principal;
    if (!principal || typeof principal !== "object" || Array.isArray(principal)) throw new ContextMessageError("mention principal is invalid", "BAD_MENTION", 400);
    const ref = principal as Record<string, unknown>;
    const start = mention.startUtf16;
    const length = mention.lengthUtf16;
    // A tagged range is `@` plus a label, and a label snapshot is capped at 80
    // UTF-16 units by principalLabel, so no legitimate token exceeds 81.
    if (!Number.isInteger(start) || !Number.isInteger(length) || Number(start) < 0 || Number(length) < 1 || Number(length) > 81) {
      throw new ContextMessageError("mention range is invalid", "BAD_MENTION", 400);
    }
    const end = Number(start) + Number(length);
    if ((index > 0 && Number(start) < previousEnd) || end > text.length
      || boundarySplitsSurrogate(text, Number(start)) || boundarySplitsSurrogate(text, end)) {
      throw new ContextMessageError("mention range is invalid", "BAD_MENTION", 400);
    }
    if ((ref.kind !== "user" && ref.kind !== "guest") || typeof ref.id !== "string" || !opaqueId.test(ref.id)) {
      throw new ContextMessageError("mention principal is invalid", "BAD_MENTION", 400);
    }
    previousEnd = end;
    return { startUtf16: Number(start), lengthUtf16: Number(length), principal: { kind: ref.kind, id: ref.id } };
  });
}

export async function mentionPrincipals(workspaceId: string, peonId: string, sessionId: string): Promise<MentionPrincipal[]> {
  const participants = await listSessionParticipants(workspaceId, peonId, sessionId);
  return participants.filter((participant) => participant.status === "active").flatMap((participant) => {
    const identity = participant.identity;
    const principal: MentionPrincipal | null = identity.userId
      ? { kind: "user", id: identity.userId, label: principalLabel(identity.githubLogin || identity.email || participant.displayName) }
      : identity.guestId ? { kind: "guest", id: identity.guestId, label: principalLabel(participant.displayName) } : null;
    return principal ? [principal] : [];
  });
}

export async function resolveMentions(
  workspaceId: string, peonId: string, sessionId: string, text: string, value: unknown, nullable = false,
): Promise<NormalizedMention[] | null> {
  const mentions = validateMentionInputs(text, value, nullable);
  if (mentions === null) return null;
  const principals = new Map((await mentionPrincipals(workspaceId, peonId, sessionId)).map((principal) => [`${principal.kind}:${principal.id}`, principal]));
  return mentions.map((mention) => {
    const principal = principals.get(`${mention.principal.kind}:${mention.principal.id}`);
    if (!principal) throw new ContextMessageError("mention principal is not visible in this session", "MENTION_PRINCIPAL_NOT_FOUND", 404);
    return { ...mention, principal };
  });
}

export function authorPrincipal(input: {
  userId: string;
  operator: { email: string; githubLogin: string | null };
  participant?: SessionParticipantAuth;
}): MentionPrincipal {
  const participant = input.participant;
  if (participant?.guestId) return { kind: "guest", id: participant.guestId, label: principalLabel(participant.displayName) };
  const userId = participant?.userId ?? input.userId;
  return { kind: "user", id: userId, label: principalLabel(participant?.displayName || input.operator.githubLogin || input.operator.email) };
}

export function validateContextAttachments(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new ContextMessageError("context message attachments are invalid", "BAD_CONTEXT_MESSAGE", 400);
  }
  return value;
}

function mentionEvent(value: unknown): { eventId: string; author: MentionPrincipal; mentions: NormalizedMention[] } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if ((event.type !== "participant_message" && event.type !== "user_message") || typeof event.eventId !== "string" || !eventIdPattern.test(event.eventId)
    || !Array.isArray(event.mentions)) return null;
  const author = event.type === "participant_message" ? event.author : event.authorPrincipal;
  if (!author || typeof author !== "object" || Array.isArray(author)) return null;
  return { eventId: event.eventId, author: author as unknown as MentionPrincipal, mentions: event.mentions as NormalizedMention[] };
}

async function publishMentionAttention(input: {
  workspaceId: string; peonId: string; sessionId: string; eventId: string; recipient: MentionPrincipalRef; unread: boolean; updatedAt: number;
}) {
  return appendEvent({
    workspaceId: input.workspaceId,
    peonId: input.peonId,
    sessionId: input.sessionId,
    kind: "mention_attention",
    payload: {
      peonId: input.peonId, sessionId: input.sessionId, eventId: input.eventId,
      recipient: input.recipient, unread: input.unread, updatedAt: input.updatedAt,
    } satisfies MentionAttentionPayload,
  });
}

export async function recordMentionAttention(
  workspaceId: string, peonId: string, sessionId: string, rawEvent: unknown,
): Promise<void> {
  const event = mentionEvent(rawEvent);
  if (!event) return;
  const authorKey = `${event.author.kind}:${event.author.id}`;
  const recipients = new Map<string, MentionPrincipalRef>();
  for (const mention of event.mentions) {
    const principal = mention?.principal;
    if (!principal || (principal.kind !== "user" && principal.kind !== "guest") || typeof principal.id !== "string") continue;
    const key = `${principal.kind}:${principal.id}`;
    if (key !== authorKey) recipients.set(key, { kind: principal.kind, id: principal.id });
  }
  const now = Date.now();
  for (const recipient of recipients.values()) {
    const occurrenceId = randomUUID();
    const inserted = await query(
      `INSERT INTO session_mention_attention
         (occurrence_id,workspace_id,recipient_kind,recipient_id,peon_id,session_id,event_id,state,created_at,updated_at,read_at)
       VALUES ($8,$1,$2,$3,$4,$5,$6,'unread',$7,$7,NULL)
       ON CONFLICT (workspace_id,recipient_kind,recipient_id,peon_id,session_id,event_id) DO NOTHING
       RETURNING occurrence_id`,
      [workspaceId, recipient.kind, recipient.id, peonId, sessionId, event.eventId, now, occurrenceId],
    );
    if ((inserted.rows[0] as { occurrence_id?: string } | undefined)?.occurrence_id === occurrenceId) {
      const live = await publishMentionAttention({ workspaceId, peonId, sessionId, eventId: event.eventId, recipient, unread: true, updatedAt: now });
      await query(`UPDATE session_mention_attention SET event_cursor=$2 WHERE occurrence_id=$1`, [occurrenceId, live.cursor]);
    }
  }
}

export async function listMentionAttention(
  workspaceId: string, peonId: string, sessionId: string, recipient: MentionPrincipalRef,
): Promise<MentionAttentionPayload[]> {
  const { rows } = await query<{ event_id: string; updated_at: number }>(
    `SELECT event_id,updated_at FROM session_mention_attention
      WHERE workspace_id=$1 AND recipient_kind=$2 AND recipient_id=$3 AND peon_id=$4 AND session_id=$5 AND state='unread'
      ORDER BY created_at ASC LIMIT 100`,
    [workspaceId, recipient.kind, recipient.id, peonId, sessionId],
  );
  return rows.map((row) => ({ peonId, sessionId, eventId: row.event_id, recipient, unread: true, updatedAt: row.updated_at }));
}

export function validateMentionReadIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100 || value.some((id) => typeof id !== "string" || !eventIdPattern.test(id))
    || new Set(value).size !== value.length) throw new ContextMessageError("mention acknowledgement is invalid", "BAD_MENTION_ACK", 400);
  return value as string[];
}

export async function markMentionAttentionRead(
  workspaceId: string, peonId: string, sessionId: string, recipient: MentionPrincipalRef, rawEventIds: unknown,
): Promise<void> {
  const eventIds = validateMentionReadIds(rawEventIds);
  const now = Date.now();
  const { rows } = await query<{ event_id: string; event_cursor: number | null }>(
    `UPDATE session_mention_attention SET state='read',read_at=$7,updated_at=$7
      WHERE workspace_id=$1 AND recipient_kind=$2 AND recipient_id=$3 AND peon_id=$4 AND session_id=$5
        AND event_id = ANY($6) AND state='unread' RETURNING event_id,event_cursor`,
    [workspaceId, recipient.kind, recipient.id, peonId, sessionId, eventIds, now],
  );
  const pendingCursors = rows.flatMap((row) => row.event_cursor === null ? [] : [row.event_cursor]);
  if (pendingCursors.length) await query(`DELETE FROM push_outbox WHERE event_cursor = ANY($1::bigint[]) AND delivered_at IS NULL`, [pendingCursors]);
  for (const row of rows) await publishMentionAttention({ workspaceId, peonId, sessionId, eventId: row.event_id, recipient, unread: false, updatedAt: now });
}

export async function deleteMentionAttention(peonId: string, sessionId: string): Promise<void> {
  await query(`DELETE FROM session_mention_attention WHERE peon_id=$1 AND session_id=$2`, [peonId, sessionId]);
}
