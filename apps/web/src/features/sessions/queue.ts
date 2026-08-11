import { api } from "../../shared/api";
import type { ApiRequest } from "../fleet/peonApi";
import type { MessageAttachment } from "./parsing";

export interface QueueItem {
  id: string;
  type: "queue" | "steer";
  sessionId: string;
  prompt: string;
  attachments: MessageAttachment[];
  permissionMode: string | null;
  author: string | null;
  model: string | null;
  reasoningEffort: string | null;
  commandId: string | null;
  queuedAt: number;
}

export interface EnqueueInput {
  prompt: string;
  permissionMode?: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: Array<{ type: "file" | "image"; path: string }>;
  commandId?: string;
  startNow?: boolean;
}

export interface QueueActivityTracker {
  replace: (sessionKey: string, items: readonly QueueItem[]) => void;
  hasPending: (sessionKey: string) => boolean;
}

// A result ends one turn, not necessarily the queued chain. Keep this tiny
// session-keyed tracker outside React state so a result frame and the queue GET
// it triggers cannot create an idle render between consecutive queued turns.
export function createQueueActivityTracker(): QueueActivityTracker {
  let current: { sessionKey: string; pending: boolean } | null = null;
  return {
    replace(sessionKey, items) {
      current = { sessionKey, pending: items.length > 0 };
    },
    hasPending(sessionKey) {
      return current?.sessionKey === sessionKey && current.pending;
    },
  };
}

const queuePath = (base: string, sessionId: string) => `${base}/sessions/${encodeURIComponent(sessionId)}/queue`;

// StrictMode deliberately mounts effects twice in development. Keep the
// authority read shared for the lifetime of the request so the replacement
// lifecycle observes the same answer instead of issuing a second Fleet GET.
const queueReads = new Map<string, Promise<QueueItem[]>>();
const CONTROL_READ_TIMEOUT_MS = 15_000;

export function getSessionQueue(
  base: string,
  sessionId: string,
  request: ApiRequest = api,
  ownerScope = "",
): Promise<QueueItem[]> {
  const path = queuePath(base, sessionId);
  const key = ownerScope ? `${ownerScope}\0${path}` : null;
  const existing = key ? queueReads.get(key) : null;
  if (existing) return existing;
  const controller = request === api ? new AbortController() : null;
  const timeout = controller ? window.setTimeout(() => controller.abort(), CONTROL_READ_TIMEOUT_MS) : null;
  const read = request<{ items?: QueueItem[] }>(path, controller ? { signal: controller.signal } : undefined)
    .then((response) => (response.items ?? []).map((item) => ({ ...item, type: item.type === "steer" ? "steer" as const : "queue" as const })))
    .finally(() => {
      if (timeout !== null) window.clearTimeout(timeout);
      if (key && queueReads.get(key) === read) queueReads.delete(key);
    });
  if (key) queueReads.set(key, read);
  return read;
}

export function enqueueSessionFollowup(base: string, sessionId: string, input: EnqueueInput, request: ApiRequest = api) {
  return request(queuePath(base, sessionId), { method: "POST", body: JSON.stringify(input) });
}

export function removeSessionQueueItem(base: string, sessionId: string, itemId: string, request: ApiRequest = api) {
  return request(`${queuePath(base, sessionId)}/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

export function steerSessionQueueItem(base: string, sessionId: string, itemId: string, request: ApiRequest = api) {
  return request(`${queuePath(base, sessionId)}/${encodeURIComponent(itemId)}/steer`, { method: "POST" });
}

/** @deprecated Use steerSessionQueueItem. */
export function sendSessionQueueItemNow(base: string, sessionId: string, itemId: string, request: ApiRequest = api) {
  return request(`${queuePath(base, sessionId)}/${encodeURIComponent(itemId)}/send`, { method: "POST" });
}

// Queue snapshots are authoritative and must be applied in the order fetched.
// Serializing refreshes also guarantees that a change received during a GET
// triggers one final GET instead of allowing stale parallel responses to reorder
// the list on screen.
export function createQueueReconciler(
  load: () => Promise<QueueItem[]>,
  apply: (items: QueueItem[]) => void,
  failed: (error: unknown) => void = () => {},
) {
  let active = false;
  let again = false;
  let disposed = false;

  const reconcile = async (): Promise<void> => {
    if (disposed) return;
    if (active) {
      again = true;
      return;
    }
    active = true;
    do {
      again = false;
      try {
        const items = await load();
        if (!disposed) apply(items);
      } catch (error) {
        if (!disposed) failed(error);
      }
    } while (!disposed && again);
    active = false;
  };

  return { reconcile, dispose: () => { disposed = true; } };
}

export function attachmentLabel(attachment: MessageAttachment): string {
  if (attachment.name) return attachment.name;
  if (!attachment.path) return attachment.type === "image" ? "image" : "file";
  return attachment.path.split(/[\\/]/).filter(Boolean).pop() ?? attachment.path;
}

export async function removeWaitingQueueItem(
  itemId: string,
  remove: (id: string) => Promise<unknown>,
  reconcile: () => Promise<void>,
  failed: (error: unknown) => void,
): Promise<void> {
  try {
    await remove(itemId);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
    if (code !== "UNKNOWN_QUEUE_ITEM") failed(error);
  } finally {
    await reconcile();
  }
}

export async function sendWaitingQueueItemNow(
  itemId: string,
  sendNow: (id: string) => Promise<unknown>,
  reconcile: () => Promise<void>,
  failed: (error: unknown) => void,
): Promise<boolean> {
  let accepted = false;
  try {
    await sendNow(itemId);
    accepted = true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
    // The Peon may have automatically popped this item just before the click.
    // Reconcile silently, but do not claim this click started work: another
    // operator may also have removed it.
    if (code !== "UNKNOWN_QUEUE_ITEM") failed(error);
  } finally {
    await reconcile();
  }
  return accepted;
}
