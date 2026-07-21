import { WebSocket } from "ws";

// Process-local connection presence. Overseer is intentionally rebuildable:
// after a restart every Peon is offline until its outbound socket reconnects.
// The socket object is also the generation fence — a stale close from a
// replaced connection cannot remove the newer connection.
const connections = new Map<string, WebSocket>();
const capabilities = new WeakMap<WebSocket, ReadonlySet<string>>();

export function claimPeonConnection(peonId: string, socket: WebSocket, acceptedCapabilities: readonly string[] = []): WebSocket | undefined {
  const previous = connections.get(peonId);
  connections.set(peonId, socket);
  capabilities.set(socket, new Set(acceptedCapabilities));
  return previous === socket ? undefined : previous;
}

export function releasePeonConnection(peonId: string, socket: WebSocket): boolean {
  if (connections.get(peonId) !== socket) return false;
  connections.delete(peonId);
  return true;
}

export function isPeonConnected(peonId: string): boolean {
  return connections.has(peonId);
}

export function getPeonConnection(peonId: string): WebSocket | undefined {
  const socket = connections.get(peonId);
  return socket?.readyState === WebSocket.OPEN ? socket : undefined;
}

export function peonConnectionSupports(socket: WebSocket, capability: string): boolean {
  return capabilities.get(socket)?.has(capability) === true;
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
