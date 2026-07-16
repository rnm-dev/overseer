export interface PresenceLocation {
  scope: "workspace" | "peon" | "session";
  peonId?: string;
  sessionId?: string;
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
