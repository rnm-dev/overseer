export interface PresenceLocation {
  scope: "workspace" | "peon" | "session";
  peonId?: string;
  sessionId?: string;
}

export interface PresenceViewer {
  userId: string;
  email: string;
  githubLogin: string | null;
  avatarUrl: string | null;
}

export function presenceLocationForPath(pathname: string): PresenceLocation {
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (parts[0] === "workspaces" && parts[1] && parts[2] === "sessions" && parts[3] && parts[4]) {
    return { scope: "session", peonId: parts[3], sessionId: parts[4] };
  }
  if (parts[0] !== "peons" || !parts[1]) return { scope: "workspace" };
  const peonId = parts[1];
  if (parts[2] === "sessions" && parts[3] && parts[3] !== "new") return { scope: "session", peonId, sessionId: parts[3] };
  return { scope: "peon", peonId };
}

export function reconcileLocalPresence(
  entries: PresenceViewer[],
  localUser: PresenceViewer | null,
  matchesLocalRoute: boolean,
  replaceStaleLocal = false,
): PresenceViewer[] {
  // The socket snapshot necessarily trails client-side navigation by one round
  // trip. While the new route is unacknowledged, do not render this tab's old
  // authoritative row next to its new optimistic route. Once acknowledged,
  // retain same-user rows because they can belong to another open tab.
  const remote = localUser && replaceStaleLocal
    ? entries.filter((entry) => entry.email.toLowerCase() !== localUser.email.toLowerCase())
    : entries;
  const viewers = uniqueUsers(remote);
  return localUser && matchesLocalRoute && !viewers.some((entry) => entry.email.toLowerCase() === localUser.email.toLowerCase())
    ? [localUser, ...viewers]
    : viewers;
}

export function presenceLocationKey(location: PresenceLocation): string {
  return `${location.scope}\0${location.peonId ?? ""}\0${location.sessionId ?? ""}`;
}

function uniqueUsers(entries: PresenceViewer[]): PresenceViewer[] {
  const users = new Map<string, PresenceViewer>();
  for (const entry of entries) {
    const key = entry.email.toLowerCase();
    if (!users.has(key)) users.set(key, entry);
  }
  return [...users.values()].sort((a, b) => (a.githubLogin || a.email).localeCompare(b.githubLogin || b.email));
}
