import { WebSocket } from "ws";

// Transfer sockets are deliberately independent from authoritative Peon
// presence. Losing this data-plane connection must not mark the control plane
// offline, and a replacement is fenced by the socket object itself.
const connections = new Map<string, WebSocket>();
const capabilities = new WeakMap<WebSocket, ReadonlySet<string>>();
export const PROJECT_FILE_READ_CAPABILITY = "project-file-read-v1";

export function claimPeonTransferConnection(peonId: string, socket: WebSocket, acceptedCapabilities: readonly string[] = []): WebSocket | undefined {
  const previous = connections.get(peonId);
  connections.set(peonId, socket);
  capabilities.set(socket, new Set(acceptedCapabilities));
  return previous === socket ? undefined : previous;
}

export function releasePeonTransferConnection(peonId: string, socket: WebSocket): boolean {
  if (connections.get(peonId) !== socket) return false;
  connections.delete(peonId);
  return true;
}

export function isPeonTransferConnected(peonId: string): boolean {
  return connections.get(peonId)?.readyState === WebSocket.OPEN;
}

export function getPeonTransferConnection(peonId: string, requiredCapability?: string): WebSocket | undefined {
  const socket = connections.get(peonId);
  if (socket?.readyState !== WebSocket.OPEN) return undefined;
  return !requiredCapability || capabilities.get(socket)?.has(requiredCapability) ? socket : undefined;
}

export function evictPeonTransferConnection(peonId: string): boolean {
  const socket = connections.get(peonId);
  if (!socket) return false;
  // Keep the generation claim until the socket's close handler releases it and
  // fails every stream owned by this exact socket. `terminate()` changes the
  // ready state immediately, so no new transfer can be opened in the meantime.
  socket.terminate();
  return true;
}
