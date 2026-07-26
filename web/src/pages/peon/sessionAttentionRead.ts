// author: Viktor
// Attention is per-user "this finished while you were not looking". Marking a
// session read is therefore only honest when the operator is actually in front
// of it: an open-but-hidden tab must keep the unread edge, and the read lands
// when they come back. Kept separate from the pane so it is unit-testable.

export function shouldMarkAttentionRead(visibility: string | undefined, focused = true): boolean {
  if (visibility === "hidden") return false;
  return focused;
}

export function documentPresence(doc?: Pick<Document, "visibilityState" | "hasFocus">): boolean {
  if (!doc) return true;
  return shouldMarkAttentionRead(doc.visibilityState, doc.hasFocus());
}
