export const CONTEXT_MESSAGES_CAPABILITY = "context-only-messages-v1";

export interface MentionPrincipal { kind: "user" | "guest"; id: string; label: string }
export interface ComposerMention {
  startUtf16: number;
  lengthUtf16: number;
  principal: MentionPrincipal;
}

// The picker follows the caret, not the end of the draft: a person can be added
// to a sentence that is already written.
export function activeMentionQuery(text: string, caret: number = text.length): { startUtf16: number; query: string } | null {
  const head = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = /(?:^|\s)@([^\s@]*)$/u.exec(head);
  if (!match) return null;
  return { startUtf16: head.length - match[1]!.length - 1, query: match[1]! };
}

export function insertMention(
  text: string,
  query: { startUtf16: number; query: string },
  principal: MentionPrincipal,
  mentions: readonly ComposerMention[] = [],
) {
  const token = `@${principal.label}`;
  const replacedEnd = query.startUtf16 + query.query.length + 1;
  // The token is followed by exactly one space, including when it lands inside
  // a sentence that already has one there.
  const trailing = text[replacedEnd] === " " ? "" : " ";
  const nextText = `${text.slice(0, query.startUtf16)}${token}${trailing}${text.slice(replacedEnd)}`;
  const mention = { startUtf16: query.startUtf16, lengthUtf16: token.length, principal } satisfies ComposerMention;
  const delta = token.length + trailing.length - (replacedEnd - query.startUtf16);
  const shifted = mentions.map((existing) => existing.startUtf16 >= replacedEnd
    ? { ...existing, startUtf16: existing.startUtf16 + delta }
    : existing);
  return { text: nextText, mention, mentions: validComposerMentions(nextText, [...shifted, mention]) };
}

// Free typing moves the tokens around. Ranges are re-anchored across the edited
// span so a word added earlier in the draft cannot silently demote a selected
// person to plain text — and with it flip the send lane.
export function remapMentions(previous: string, next: string, mentions: readonly ComposerMention[]): ComposerMention[] {
  if (previous === next) return validComposerMentions(next, mentions);
  const shortest = Math.min(previous.length, next.length);
  let prefix = 0;
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const editedEnd = previous.length - suffix;
  const delta = next.length - previous.length;
  return validComposerMentions(next, mentions.flatMap((mention) => {
    if (mention.startUtf16 + mention.lengthUtf16 <= prefix) return [mention];
    if (mention.startUtf16 >= editedEnd) return [{ ...mention, startUtf16: mention.startUtf16 + delta }];
    return [];
  }));
}

export function removeMention(text: string, mentions: readonly ComposerMention[], target: ComposerMention) {
  const tokenEnd = target.startUtf16 + target.lengthUtf16;
  const removeEnd = text[tokenEnd] === " " ? tokenEnd + 1 : tokenEnd;
  const removedLength = removeEnd - target.startUtf16;
  const nextText = `${text.slice(0, target.startUtf16)}${text.slice(removeEnd)}`;
  const nextMentions = mentions
    .filter((mention) => mention !== target)
    .map((mention) => mention.startUtf16 > target.startUtf16
      ? { ...mention, startUtf16: mention.startUtf16 - removedLength }
      : mention);
  return { text: nextText, mentions: validComposerMentions(nextText, nextMentions) };
}

export function mentionForAtomicDeletion(
  text: string,
  mentions: readonly ComposerMention[],
  selectionStart: number,
  selectionEnd: number,
  key: "Backspace" | "Delete",
): ComposerMention | null {
  if (selectionStart !== selectionEnd) return null;
  return mentions.find((mention) => {
    const start = mention.startUtf16;
    const end = start + mention.lengthUtf16;
    if (key === "Backspace") return selectionStart > start && selectionStart <= end + (text[end] === " " ? 1 : 0);
    return selectionStart >= start && selectionStart < end;
  }) ?? null;
}

// Free editing is allowed, but a token whose exact selected label was changed
// ceases to be a structured mention. Raw @text remains plain text by contract.
export function validComposerMentions(text: string, mentions: readonly ComposerMention[]): ComposerMention[] {
  return mentions
    .filter((mention) => text.slice(mention.startUtf16, mention.startUtf16 + mention.lengthUtf16) === `@${mention.principal.label}`)
    .sort((a, b) => a.startUtf16 - b.startUtf16)
    .filter((mention, index, all) => index === 0 || all[index - 1]!.startUtf16 + all[index - 1]!.lengthUtf16 <= mention.startUtf16);
}

export function mentionWire(mentions: readonly ComposerMention[]) {
  return mentions.map(({ startUtf16, lengthUtf16, principal }) => ({
    startUtf16, lengthUtf16, principal: { kind: principal.kind, id: principal.id },
  }));
}

export function mentionsRouteToPeople(mentions: readonly ComposerMention[]): boolean {
  return mentions.some((mention) => mention.startUtf16 === 0);
}
