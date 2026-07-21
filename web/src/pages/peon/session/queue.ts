import { api } from "../../../api";
import type { ApiRequest } from "../peonApi";
import type { MessageAttachment } from "./parsing";

export interface QueueItem {
  id: string;
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

export async function getSessionQueue(base: string, sessionId: string, request: ApiRequest = api): Promise<QueueItem[]> {
  const response = await request<{ items?: QueueItem[] }>(queuePath(base, sessionId));
  return response.items ?? [];
}

export function enqueueSessionFollowup(base: string, sessionId: string, input: EnqueueInput, request: ApiRequest = api) {
  return request(queuePath(base, sessionId), { method: "POST", body: JSON.stringify(input) });
}

export function removeSessionQueueItem(base: string, sessionId: string, itemId: string, request: ApiRequest = api) {
  return request(`${queuePath(base, sessionId)}/${encodeURIComponent(itemId)}`, { method: "DELETE" });
}

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
): Promise<void> {
  try {
    await sendNow(itemId);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
    if (code !== "UNKNOWN_QUEUE_ITEM") failed(error);
  } finally {
    await reconcile();
  }
}
