// Sound belongs to one app at a time — the one the operator picked up last.
//
// The overseer keeps the stack of an operator's open clients and tells this one
// whether it is on top (see app/src/modules/presence/audioFocus.ts). Until it
// says otherwise this client plays: a lone tab, an older overseer, or a socket
// that has not connected yet must never end up silently muted.
// author: Viktor

const CLIENT_ID_STORAGE_KEY = "overseer.audio-client-id";

let cachedClientId: string | null = null;
let primary = true;
const listeners = new Set<(primary: boolean) => void>();
let sendClaim: (() => void) | null = null;

function randomId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `client-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  }
}

// Per tab, not per socket: one tab may hold several sockets (the selected
// workspace plus fleet-dashboard ones) and they must count as one client.
// sessionStorage keeps that identity across a reload but not across tabs.
export function audioClientId(): string {
  if (cachedClientId) return cachedClientId;
  try {
    const stored = window.sessionStorage.getItem(CLIENT_ID_STORAGE_KEY);
    if (stored) {
      cachedClientId = stored;
      return stored;
    }
  } catch {
    // A private/restricted browser may deny storage; a per-load id still works.
  }
  const generated = randomId();
  try {
    window.sessionStorage.setItem(CLIENT_ID_STORAGE_KEY, generated);
  } catch {
    // Same: the id just stops surviving reloads, which costs nothing but a bump.
  }
  cachedClientId = generated;
  return generated;
}

export function isAudioPrimary(): boolean {
  return primary;
}

export function setAudioPrimary(next: boolean): void {
  if (primary === next) return;
  primary = next;
  for (const listener of listeners) listener(next);
}

export function onAudioPrimaryChange(listener: (primary: boolean) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The live socket registers how to reach the overseer while it is connected.
export function setAudioClaimSender(send: (() => void) | null): void {
  sendClaim = send;
}

// A deliberate gesture here — starting or stopping a run. Take the sound
// optimistically so the click is audible immediately, and tell the overseer so
// the operator's other clients go quiet.
export function claimAudioFocus(): void {
  setAudioPrimary(true);
  sendClaim?.();
}
