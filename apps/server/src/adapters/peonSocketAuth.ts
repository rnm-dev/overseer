import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { resolveCredential } from "../modules/fleet/index.js";
import { registry, type PeonRecord } from "../modules/fleet/index.js";

export interface AuthenticatedPeonUpgrade {
  record: PeonRecord;
}

function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function rejectUpgrade(socket: Duplex, status: 401 | 404 | 503, reason: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// Shared authentication boundary for every Peon-initiated WebSocket channel.
// Authentication completes before upgrade, so revoked, unbound, or cross-
// workspace credentials never become accepted WebSocket connections.
export async function authenticatePeonUpgrade(req: IncomingMessage, socket: Duplex): Promise<AuthenticatedPeonUpgrade | null> {
  try {
    const credential = await resolveCredential(bearer(req));
    if (!credential?.boundPeonId) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return null;
    }
    const record = await registry.get(credential.boundPeonId);
    if (!record || record.credentialId !== credential.id || record.workspaceId !== credential.workspaceId) {
      rejectUpgrade(socket, 404, "Not Found");
      return null;
    }
    return { record };
  } catch {
    rejectUpgrade(socket, 503, "Service Unavailable");
    return null;
  }
}
