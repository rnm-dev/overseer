import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

// Process-local connection presence. Overseer is intentionally rebuildable:
// after a restart every Peon is offline until its outbound socket reconnects.
// The socket object is also the generation fence — a stale close from a
// replaced connection cannot remove the newer connection.
const connections = new Map<string, WebSocket>();
const capabilities = new WeakMap<WebSocket, ReadonlySet<string>>();
const commandOperations = new WeakMap<WebSocket, ReadonlySet<string>>();
const generations = new WeakMap<WebSocket, string>();
const connectedAt = new WeakMap<WebSocket, number>();
const credentialGenerations = new WeakMap<WebSocket, number>();

export interface PeonConnectionClaim {
  accepted: boolean;
  previous?: WebSocket;
}

export function claimPeonConnection(
  peonId: string,
  socket: WebSocket,
  acceptedCapabilities: readonly string[] = [],
  acceptedCommandOperations: readonly string[] = [],
  credentialGeneration = 0,
): PeonConnectionClaim {
  const previous = connections.get(peonId);
  const previousGeneration = previous ? credentialGenerations.get(previous) ?? 0 : 0;
  if (previous && previous !== socket && previousGeneration > credentialGeneration) {
    return { accepted: false };
  }
  connections.set(peonId, socket);
  capabilities.set(socket, new Set(acceptedCapabilities));
  commandOperations.set(socket, new Set(acceptedCommandOperations));
  generations.set(socket, randomUUID());
  connectedAt.set(socket, Date.now());
  credentialGenerations.set(socket, credentialGeneration);
  return { accepted: true, ...(previous !== socket && previous ? { previous } : {}) };
}

export function activatePeonCommandConnection(
  peonId: string,
  socket: WebSocket,
  generation: string,
  capability: string,
  operations: readonly string[],
): boolean {
  if (!isCurrentPeonConnection(peonId, socket, generation)) return false;
  capabilities.set(socket, new Set([...(capabilities.get(socket) ?? []), capability]));
  commandOperations.set(socket, new Set(operations));
  return true;
}

export function releasePeonConnection(peonId: string, socket: WebSocket): boolean {
  if (connections.get(peonId) !== socket) return false;
  connections.delete(peonId);
  return true;
}

export function isPeonConnected(peonId: string): boolean {
  return connections.has(peonId);
}

export function peonConnectionStartedAt(peonId: string): number | null {
  const socket = connections.get(peonId);
  return socket ? connectedAt.get(socket) ?? null : null;
}

export function getPeonConnection(peonId: string): WebSocket | undefined {
  const socket = connections.get(peonId);
  return socket?.readyState === WebSocket.OPEN ? socket : undefined;
}

export function peonConnectionSupports(socket: WebSocket, capability: string): boolean {
  return capabilities.get(socket)?.has(capability) === true;
}

export function peonConnectionSupportsCommand(socket: WebSocket, operation: string): boolean {
  return commandOperations.get(socket)?.has(operation) === true;
}

export function peonConnectionGeneration(socket: WebSocket): string | null {
  return generations.get(socket) ?? null;
}

export function isCurrentPeonConnection(
  peonId: string,
  socket: WebSocket,
  generation: string,
): boolean {
  return connections.get(peonId) === socket
    && socket.readyState === WebSocket.OPEN
    && generations.get(socket) === generation;
}

// Credential revocation is an immediate authorization boundary. Remove the
// socket from authoritative presence before terminating it so no subsequent
// read or command lookup can observe the revoked connection as usable.
export function evictPeonConnection(peonId: string): boolean {
  const socket = connections.get(peonId);
  if (!socket) return false;
  connections.delete(peonId);
  socket.terminate();
  return true;
}

export function evictPeonConnectionsBelowGeneration(peonId: string, generation: number): boolean {
  const socket = connections.get(peonId);
  if (!socket || (credentialGenerations.get(socket) ?? 0) >= generation) return false;
  connections.delete(peonId);
  socket.terminate();
  return true;
}

export function evictPeonConnectionGeneration(peonId: string, generation: number): boolean {
  const socket = connections.get(peonId);
  if (!socket || (credentialGenerations.get(socket) ?? 0) !== generation) return false;
  connections.delete(peonId);
  socket.terminate();
  return true;
}
