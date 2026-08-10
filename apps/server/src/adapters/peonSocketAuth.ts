import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { resolveCredential } from "../modules/fleet/index.js";
import { registry, type PeonRecord } from "../modules/fleet/index.js";
import { refuseUpgrade } from "./upgradeGuard.js";

export interface AuthenticatedPeonUpgrade {
  record: PeonRecord;
}

function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization ?? "";
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
}

function rejectUpgrade(socket: Duplex, status: 401 | 404 | 503, reason: string): void {
  refuseUpgrade(socket, status, reason);
}

// Names the Peon behind an upgrade we are about to refuse, so an outdated
// daemon dialling a retired endpoint can be found and updated. Returns the
// record's name and id only — never the credential it presented.
export async function describePeonUpgrade(req: IncomingMessage): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  try {
    const credential = await resolveCredential(token);
    if (!credential?.boundPeonId) return null;
    const record = await registry.get(credential.boundPeonId);
    return record ? `peon ${JSON.stringify(record.name)} (${record.peonId})` : `peon ${credential.boundPeonId}`;
  } catch {
    return null;
  }
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
