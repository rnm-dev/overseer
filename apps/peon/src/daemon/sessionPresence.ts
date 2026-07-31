import { EventEmitter } from "node:events";

// Purely in-memory — presence is a live-only concept with no reason to
// survive a restart, exactly like sessions service's own activeSessionId/activeRun.
// Refcounted per (sessionId, username) rather than per-connection so that N
// browser tabs from the same user collapse to one entry in the distinct
// viewer set, while still cleaning up correctly however those tabs close
// (independently, in any order) — Node's single-threaded event loop
// serializes join()/leave() calls, so there's no race between them.
class SessionPresenceStore extends EventEmitter {
  private viewers = new Map<string, Map<string, number>>();

  // Emits "change" only when the distinct viewer set for this session
  // actually changed (0→1 on join, 1→0 on leave) — a second tab from an
  // already-present user is silent, since nothing observable changed.
  join(sessionId: string, username: string): void {
    let byUsername = this.viewers.get(sessionId);
    if (!byUsername) {
      byUsername = new Map();
      this.viewers.set(sessionId, byUsername);
    }
    const count = (byUsername.get(username) ?? 0) + 1;
    byUsername.set(username, count);
    if (count === 1) this.emit("change", { sessionId, viewers: this.list(sessionId) });
  }

  leave(sessionId: string, username: string): void {
    const byUsername = this.viewers.get(sessionId);
    if (!byUsername || !byUsername.has(username)) return;
    const count = (byUsername.get(username) ?? 0) - 1;
    if (count <= 0) {
      byUsername.delete(username);
      if (byUsername.size === 0) this.viewers.delete(sessionId);
      this.emit("change", { sessionId, viewers: this.list(sessionId) });
    } else {
      byUsername.set(username, count);
    }
  }

  // Distinct usernames currently viewing, sorted for stable ordering
  // regardless of connect order.
  list(sessionId: string): string[] {
    const byUsername = this.viewers.get(sessionId);
    return byUsername ? Array.from(byUsername.keys()).sort() : [];
  }
}

export const sessionPresence = new SessionPresenceStore();
