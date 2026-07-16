export function nextSessionAfterDeletion(sessionIds: string[], deletedSessionId: string): string | null {
  const index = sessionIds.indexOf(deletedSessionId);
  if (index === -1) return sessionIds[0] ?? null;
  return sessionIds[index + 1] ?? sessionIds[index - 1] ?? null;
}
