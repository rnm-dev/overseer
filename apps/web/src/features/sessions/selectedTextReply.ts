export interface SelectedTextReply {
  eventId: string;
  selectedText: string;
}

export const SELECTED_TEXT_REPLY_CAPABILITY = "selected-text-replies-v1";
export const MAX_REPLY_EVENT_ID_LENGTH = 256;
export const MAX_REPLY_SELECTED_TEXT_CHARS = 8192;
export const MAX_REPLY_SELECTED_TEXT_BYTES = 16 * 1024;

const EVENT_ID = /^[A-Za-z0-9_-]{1,256}$/;

/**
 * Keep client-side selection state on the same safe side of the Peon
 * contract. Peon is still authoritative; this only prevents a stale or
 * oversized browser selection from entering the composer.
 */
export function parseSelectedTextReply(value: unknown): SelectedTextReply | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as { eventId?: unknown; selectedText?: unknown };
  if (typeof candidate.eventId !== "string" || !EVENT_ID.test(candidate.eventId)) return null;
  if (typeof candidate.selectedText !== "string" || !candidate.selectedText.trim()) return null;
  if ([...candidate.selectedText].length > MAX_REPLY_SELECTED_TEXT_CHARS) return null;
  if (new TextEncoder().encode(candidate.selectedText).byteLength > MAX_REPLY_SELECTED_TEXT_BYTES) return null;
  return { eventId: candidate.eventId, selectedText: candidate.selectedText };
}

/**
 * Resolve a browser selection only when both ends belong to the same
 * replyable transcript row. The returned text is the browser's exact
 * selection, including whitespace and Unicode; this helper never mutates the
 * selection or composer state.
 */
export function selectedTextReplyForRow(
  row: Pick<HTMLElement, "contains">,
  eventId: string | null | undefined,
  selection: Pick<Selection, "anchorNode" | "focusNode" | "isCollapsed" | "toString"> | null | undefined,
): SelectedTextReply | null {
  if (!eventId || !selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return null;
  if (!row.contains(selection.anchorNode) || !row.contains(selection.focusNode)) return null;
  return parseSelectedTextReply({ eventId, selectedText: selection.toString() });
}

export function replyIdentity(replyTo: SelectedTextReply | null | undefined): string {
  return replyTo ? `${replyTo.eventId}\u0000${replyTo.selectedText}` : "";
}

export function replyPreview(text: string, max = 240): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max).join("")}…`;
}
