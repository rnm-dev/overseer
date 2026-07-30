import { WebSocket } from "ws";
import { observeNegotiatedConnection } from "./modules/reverseTransportMetrics.js";

// Transfer sockets are deliberately independent from authoritative Peon
// presence. Losing this data-plane connection must not mark the control plane
// offline, and a replacement is fenced by the socket object itself.
const connections = new Map<string, WebSocket>();
const capabilities = new WeakMap<WebSocket, ReadonlySet<string>>();
const connectedAt = new WeakMap<WebSocket, number>();
const credentialGenerations = new WeakMap<WebSocket, number>();
export const PROJECT_FILE_READ_CAPABILITY = "project-file-read-v1";
export const SANDBOX_FILE_READ_CAPABILITY = "sandbox-file-read-v1";
export const FILE_WRITE_CAPABILITY = "file-write-v1";
export const SESSION_ARTIFACT_CAPABILITY = "session-artifact-v1";

export interface PeonTransferConnectionClaim {
  accepted: boolean;
  previous?: WebSocket;
}

export function claimPeonTransferConnection(
  peonId: string,
  socket: WebSocket,
  acceptedCapabilities: readonly string[] = [],
  credentialGeneration = 0,
): PeonTransferConnectionClaim {
  const previous = connections.get(peonId);
  const previousGeneration = previous ? credentialGenerations.get(previous) ?? 0 : 0;
  if (previous && previous !== socket && previousGeneration > credentialGeneration) {
    return { accepted: false };
  }
  connections.set(peonId, socket);
  capabilities.set(socket, new Set(acceptedCapabilities));
  connectedAt.set(socket, Date.now());
  credentialGenerations.set(socket, credentialGeneration);
  observeNegotiatedConnection({
    plane: "transfer",
    replacement: previous !== undefined && previous !== socket,
    capabilities: acceptedCapabilities,
  });
  return { accepted: true, ...(previous !== socket && previous ? { previous } : {}) };
}

export function releasePeonTransferConnection(peonId: string, socket: WebSocket): boolean {
  if (connections.get(peonId) !== socket) return false;
  connections.delete(peonId);
  return true;
}

export function isPeonTransferConnected(peonId: string): boolean {
  return connections.get(peonId)?.readyState === WebSocket.OPEN;
}

export function peonTransferConnectionStartedAt(peonId: string): number | null {
  const socket = connections.get(peonId);
  return socket?.readyState === WebSocket.OPEN ? connectedAt.get(socket) ?? null : null;
}

export function getPeonTransferConnection(peonId: string, requiredCapability?: string): WebSocket | undefined {
  const socket = connections.get(peonId);
  if (socket?.readyState !== WebSocket.OPEN) return undefined;
  return !requiredCapability || capabilities.get(socket)?.has(requiredCapability) ? socket : undefined;
}

// The Peon's HTTP file API is being retired: a read takes the socket whenever
// the owning Peon holds one that negotiated the capability.
export function hasProjectFileTransport(peonId: string): boolean {
  return !!getPeonTransferConnection(peonId, PROJECT_FILE_READ_CAPABILITY);
}

export function hasSandboxFileTransport(peonId: string): boolean {
  return !!getPeonTransferConnection(peonId, SANDBOX_FILE_READ_CAPABILITY);
}

export function hasFileWriteTransport(peonId: string): boolean {
  return !!getPeonTransferConnection(peonId, FILE_WRITE_CAPABILITY);
}

export function hasSessionArtifactTransport(peonId: string): boolean {
  return !!getPeonTransferConnection(peonId, SESSION_ARTIFACT_CAPABILITY);
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

export function evictPeonTransferConnectionsBelowGeneration(peonId: string, generation: number): boolean {
  const socket = connections.get(peonId);
  if (!socket || (credentialGenerations.get(socket) ?? 0) >= generation) return false;
  // Keep the claim until the close handler releases this exact socket and
  // fails its pending transfers. `terminate()` immediately makes the socket
  // unavailable to new callers; deleting it here would strand in-flight work
  // until its independent timeout.
  socket.terminate();
  return true;
}

export function evictPeonTransferConnectionGeneration(peonId: string, generation: number): boolean {
  const socket = connections.get(peonId);
  if (!socket || (credentialGenerations.get(socket) ?? 0) !== generation) return false;
  // Close owns release and failure of every read/write fenced to this socket.
  socket.terminate();
  return true;
}
