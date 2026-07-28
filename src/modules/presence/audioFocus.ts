import { EventEmitter } from "node:events";

// Which one of an operator's open apps is allowed to make noise.
//
// One person, several clients: a desktop window that stays connected for days
// and a phone that joins and drops all the time. Notification sound belongs to
// whichever app they picked up last, so a user's clients are kept as a stack —
// a fresh client lands on top, a disconnect pops it and hands the slot back to
// whatever was underneath. Only the top client is told it owns audio.
//
// Recency alone is not quite enough: a phone reconnecting from a pocket would
// steal sound from the desktop the operator is sitting at. So a client that is
// actually in front of the operator (tab visible + focused) outranks one that
// is not, and a reconnect only promotes a client that is currently in front.
// author: Viktor

export const audioFocusBus = new EventEmitter();

// How long a vanished client keeps its place and its focus state. A phone on a
// bad link drops and returns constantly; forgetting it immediately would let
// every reconnect re-enter the stack as brand new and steal the sound.
const MEMORY_MS = 10 * 60_000;

interface FocusClient {
  clientId: string;
  // One client (browser tab) may hold several sockets — the selected workspace
  // plus fleet-dashboard workspaces. It stops being a candidate when the last
  // one goes, but is remembered for MEMORY_MS in case it comes back.
  connections: Set<string>;
  active: boolean;
  forgetAt: number | null;
}

const stacks = new Map<string, FocusClient[]>(); // userId → clients, most recently picked up first

const connected = (client: FocusClient) => client.connections.size > 0;

function ownerOf(clients: FocusClient[] | undefined): string | null {
  const candidates = clients?.filter(connected) ?? [];
  if (candidates.length === 0) return null;
  return (candidates.find((client) => client.active) ?? candidates[0]!).clientId;
}

// Every mutation runs through here so the bus fires exactly when the answer to
// "who owns audio?" actually changes — reshuffling below the top is silent.
function mutate(userId: string, change: (clients: FocusClient[]) => void): void {
  const now = Date.now();
  const clients = (stacks.get(userId) ?? []).filter((client) => connected(client) || (client.forgetAt ?? 0) > now);
  const before = ownerOf(clients);
  change(clients);
  if (clients.length) stacks.set(userId, clients);
  else stacks.delete(userId);
  if (ownerOf(stacks.get(userId)) !== before) audioFocusBus.emit("changed", userId);
}

function toTop(clients: FocusClient[], index: number): void {
  const [client] = clients.splice(index, 1);
  if (client) clients.unshift(client);
}

export function claimAudioFocus(userId: string, clientId: string, connectionId: string): void {
  mutate(userId, (clients) => {
    const index = clients.findIndex((client) => client.clientId === clientId);
    if (index < 0) {
      // A client can only be opened in front of the operator, so a new one is
      // active until it reports otherwise.
      clients.unshift({ clientId, connections: new Set([connectionId]), active: true, forgetAt: null });
      return;
    }
    const client = clients[index]!;
    const rejoining = !connected(client);
    client.connections.add(connectionId);
    client.forgetAt = null;
    // Only a client that is genuinely (re)arriving and is in front of the
    // operator is promoted. An extra socket from a tab that is already here
    // (a fleet-dashboard workspace) changes nothing, and a reconnect from a
    // backgrounded window — a phone waking on a flaky link — keeps its place.
    if (rejoining && client.active) toTop(clients, index);
  });
}

// Tab visibility/focus, straight from the presence heartbeat. Regaining focus is
// the operator physically returning to that machine, which is the strongest
// "use this one" signal there is.
export function setAudioFocusActive(userId: string, clientId: string, active: boolean): void {
  mutate(userId, (clients) => {
    const index = clients.findIndex((client) => client.clientId === clientId);
    if (index < 0) return;
    const client = clients[index]!;
    const regainedFocus = active && !client.active;
    client.active = active;
    if (regainedFocus) toTop(clients, index);
  });
}

// A deliberate gesture (starting or stopping a run) — the operator is provably
// at this client, whatever the focus bookkeeping says.
export function promoteAudioFocus(userId: string, clientId: string): void {
  mutate(userId, (clients) => {
    const index = clients.findIndex((client) => client.clientId === clientId);
    if (index < 0) return;
    clients[index]!.active = true;
    toTop(clients, index);
  });
}

export function releaseAudioFocus(userId: string, clientId: string, connectionId: string): void {
  mutate(userId, (clients) => {
    const index = clients.findIndex((client) => client.clientId === clientId);
    if (index < 0) return;
    const client = clients[index]!;
    client.connections.delete(connectionId);
    if (client.connections.size === 0) client.forgetAt = Date.now() + MEMORY_MS;
  });
}

export function audioFocusOwner(userId: string): string | null {
  return ownerOf(stacks.get(userId));
}

export function hasAudioFocus(userId: string, clientId: string): boolean {
  return audioFocusOwner(userId) === clientId;
}

export function resetAudioFocus(): void {
  stacks.clear();
}
