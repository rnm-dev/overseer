import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api, ApiError, isPeonNeedsUpdate, json } from "../../shared/api";
import type { Translate } from "../../shared/i18n";
import { useNotifications } from "../../shared/notifications";
import { composerDraftKey, saveComposerDraft, useComposerDraft, useComposerDraftFiles } from "./drafts";
import { attachmentUploadPath } from "../projects/fileLinks";
import type { ModelsCatalog } from "../settings/models";
import type { MessageAttachment } from "./parsing";
import { createQueueReconciler, enqueueSessionFollowup, getSessionQueue, removeSessionQueueItem, removeWaitingQueueItem, steerSessionQueueItem, sendWaitingQueueItemNow, type QueueActivityTracker, type QueueItem } from "./queue";
import { createSubmissionGate } from "./submissionGate";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DEFAULT_FILE_ROOT = "/tmp/peon-files";
const isImage = (file: File) => IMAGE_TYPES.has(file.type);
// A committed turn that never reaches the transcript must not leave the ghost
// hovering under it forever.
const GHOST_MAX_MS = 60_000;

/**
 * The message the operator has sent but Peon has not committed back yet. It is
 * deliberately *not* a transcript row: the transcript stays Peon's alone, and
 * this is a single local placeholder rendered after it. Its whole lifetime is
 * this object being non-null, so it can never be mistaken for — or left behind
 * next to — the authoritative row that replaces it.
 */
export interface ComposerGhost {
  text: string;
  attachments: MessageAttachment[];
  createdAt: number;
  /**
   * How many user messages the transcript showed when the send started. The
   * ghost retires as soon as it shows more. Counting is deliberate: Overseer
   * derives its own command id for a follow-up, so a browser cannot recognise
   * its own message in the transcript, and every attempt to match one by payload
   * was a guess. A count cannot mistake one message for another — at worst two
   * operators send at once and this ghost retires on the other's row, one beat
   * before its own arrives.
   */
  baselineUserMessages: number;
}

export function composerActionErrorMessage(error: unknown, t: Translate): string | undefined {
  const code = error instanceof ApiError ? error.code : "";
  if (error instanceof ApiError && (code === "RESUME_IN_PROGRESS" || error.status === 409)) return t("session.compose.busy");
  if (code === "FILES_DISABLED") return t("session.compose.filesDisabledHint");
  if (code === "ATTACHMENT_TOO_LARGE") return t("session.compose.tooLarge");
  if (code === "UNSUPPORTED_MEDIA_TYPE") return t("session.compose.badType");
  if (code === "UNKNOWN_ATTACHMENT_PATH" || code === "PATH_ESCAPE") return t("session.compose.uploadFailed");
  if (isPeonNeedsUpdate(error)) return t("peon.unsupported");
  return undefined;
}

// Only a stated client-side refusal proves that Peon did not accept the turn.
// Network failures and 5xx responses are ambiguous: restoring their payload to
// the visible draft can make an already-accepted follow-up appear unsent.
export function followupWasRefused(error: unknown): boolean {
  return error instanceof ApiError && error.status < 500;
}

interface Args {
  base: string;
  sid: string;
  sessionKey: string;
  wsId: string;
  peonId: string;
  t: Translate;
  running: boolean;
  runningModel: string | null;
  runningReasoningEffort: string | null;
  sessionModel: string | null;
  sessionAgent: string | null;
  sessionReasoningEffort: string | null;
  sessionPermissionMode: string | null;
  overrideModel: string;
  overrideReasoningEffort: string;
  catalog: ModelsCatalog | null;
  currentSessionKeyRef: MutableRefObject<string>;
  queueReconcilerRef: MutableRefObject<ReturnType<typeof createQueueReconciler> | null>;
  queueActivity: QueueActivityTracker;
  userMessageCount: number;
  onGhostCreated: () => void;
  setRunning: (running: boolean) => void;
  setRunningSelection: (model: string | null, reasoningEffort: string | null) => void;
  setStopNote: Dispatch<SetStateAction<string | null>>;
  onWorkStarted: () => void;
}

export function useSessionComposer({
  base, sid, sessionKey, wsId, peonId, t, running, runningModel,
  runningReasoningEffort, sessionModel, sessionAgent, sessionReasoningEffort,
  sessionPermissionMode, overrideModel,
  overrideReasoningEffort, catalog, currentSessionKeyRef, queueReconcilerRef,
  queueActivity, userMessageCount,
  onGhostCreated,
  setRunning, setRunningSelection, setStopNote, onWorkStarted,
}: Args) {
  const { notifyError } = useNotifications();
  const draftKey = composerDraftKey(wsId, peonId, sid);
  const [input, setInput] = useComposerDraft(draftKey);
  const [files, setFiles] = useComposerDraftFiles(draftKey);
  const [sending, setSending] = useState(false);
  const submissionGateRef = useRef(createSubmissionGate());
  // One request id per pending payload, as the mobile client does it. It outlives
  // a failed attempt so pressing Send again on the same message is deduplicated
  // by Overseer instead of posting a second follow-up, and is dropped as soon as
  // the payload changes or a send is accepted.
  const requestIdRef = useRef<{ identity: string; id: string } | null>(null);
  const [ghost, setGhost] = useState<ComposerGhost | null>(null);
  // Read during render so a send can capture the count before its own row can
  // possibly arrive, without waiting for an effect.
  const userMessageCountRef = useRef(userMessageCount);
  userMessageCountRef.current = userMessageCount;
  const [sendError, setSendError] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [removingQueueItems, setRemovingQueueItems] = useState<Set<string>>(new Set());
  const [sendingQueueItems, setSendingQueueItems] = useState<Set<string>>(new Set());
  const [filesEnabled, setFilesEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    setSending(false);
    setGhost(null);
    requestIdRef.current = null;
  }, [sessionKey]);

  useEffect(() => {
    if (!ghost) return;
    if (userMessageCount > ghost.baselineUserMessages) return setGhost(null);
    const id = window.setTimeout(() => setGhost(null), Math.max(0, ghost.createdAt + GHOST_MAX_MS - Date.now()));
    return () => window.clearTimeout(id);
  }, [ghost, userMessageCount]);

  function requestIdFor(identity: string): string {
    const current = requestIdRef.current;
    if (current?.identity === identity) return current.id;
    const id = crypto.randomUUID();
    requestIdRef.current = { identity, id };
    return id;
  }

  function clearRequestId(): void {
    requestIdRef.current = null;
  }

  // Whether file transfer is enabled on the peon. If it's off, auto-enable a
  // default /tmp sandbox so attaching just works (no manual Settings step).
  useEffect(() => {
    let alive = true;
    api<{ filesEnabled?: boolean }>(`${base}/status`)
      .then(async (s) => {
        if (!alive) return;
        if (s.filesEnabled) return setFilesEnabled(true);
        try {
          await api(`${base}/settings`, { method: "PATCH", body: JSON.stringify({ fileTransferRoot: DEFAULT_FILE_ROOT }) });
          if (alive) setFilesEnabled(true);
        } catch {
          if (alive) setFilesEnabled(false);
        }
      })
      .catch(() => alive && setFilesEnabled(false));
    return () => {
      alive = false;
    };
  }, [base]);

  // Upload one file to the peon sandbox (under fileTransferRoot/uploads/<sid>/).
  // Returns the committed path the peon reports.
  async function uploadFile(f: File): Promise<{ path: string; transferId?: string; size?: number; sha256?: string }> {
    const safe = f.name.replace(/[^\w.-]+/g, "_") || "file";
    const buf = await f.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await api<{ path?: string; transferId?: string; size?: number; sha256?: string }>(attachmentUploadPath(base, sid, safe), {
      method: "PUT",
      body: buf,
      headers: { "content-type": "application/octet-stream", "peon-content-sha256": hex },
    });
    if (!res.path || (res.transferId !== undefined
      && (res.size !== f.size || res.sha256 !== hex))) {
      throw new Error("Overseer returned an invalid committed attachment receipt");
    }
    return {
      path: res.path,
      ...(res.transferId ? { transferId: res.transferId, size: res.size, sha256: res.sha256 } : {}),
    };
  }

  async function send() {
    const text = input.trim();
    if (!text && files.length === 0) return;
    const submission = submissionGateRef.current.begin(sessionKey);
    if (!submission) return;
    const prompt = text || "(see attachments)";
    const pending = files;
    const wasRunning = running;
    const prevModel = runningModel;
    const prevReasoningEffort = runningReasoningEffort;
    setSending(true);
    setSendError(null);
    // The transcript stays Peon's alone. What the operator sees immediately is a
    // ghost beneath it, which retires the moment the transcript grows — so no
    // rendered row ever has to be matched back to an authoritative one.
    //
    // The request id is stable across retries of an unchanged payload. A lost
    // response leaves the browser unable to tell a refused send from a committed
    // one, and reusing the key makes pressing Send again idempotent at Overseer
    // rather than a second message.
    const clientId = requestIdFor(JSON.stringify([
      sessionKey, prompt, overrideModel, overrideReasoningEffort,
      pending.map((f) => [f.name, f.size, f.lastModified]),
    ]));
    // Let the transcript freeze its current viewport before the new row enters.
    // It will scroll only after Virtuoso has measured the committed ghost.
    onGhostCreated();
    setGhost({
      text: prompt,
      attachments: pending.map((f) => ({ type: isImage(f) ? "image" : "file", name: f.name, size: f.size })),
      createdAt: Date.now(),
      baselineUserMessages: userMessageCountRef.current,
    });
    setRunning(true);
    setRunningSelection(
      overrideModel || sessionModel || (!sessionAgent ? catalog?.defaultModel : null) || null,
      overrideReasoningEffort || sessionReasoningEffort || null,
    );
    setStopNote(null);
    setInput("");
    setFiles([]);
    try {
      // Upload each file to the sandbox, then send native attachments[] (peon
      // presents images as visual content to the agent via its Read tool).
      const attachments: { type: "file" | "image"; path: string; transferId?: string; size?: number; sha256?: string }[] = [];
      for (const f of pending) attachments.push({ type: isImage(f) ? "image" : "file", ...await uploadFile(f) });
      const body: { prompt: string; attachments?: typeof attachments; model?: string; reasoningEffort?: string } = { prompt };
      if (attachments.length) body.attachments = attachments;
      if (overrideModel) body.model = overrideModel; // becomes the session default after acceptance
      if (overrideReasoningEffort) body.reasoningEffort = overrideReasoningEffort;
      const request = json(body);
      request.headers = { "Peon-Request-Id": clientId };
      await api(`${base}/sessions/${encodeURIComponent(sid)}/followup`, request);
      clearRequestId();
      if (currentSessionKeyRef.current === sessionKey) onWorkStarted();
    } catch (err) {
      // A refusal Overseer stated outright is final: nothing was committed, so
      // the next attempt is a new command and must not be answered from this
      // one's record. Only a 5xx or a lost connection leaves the outcome unknown
      // and keeps the request id for an idempotent retry.
      const refused = followupWasRefused(err);
      if (refused) clearRequestId();
      if (currentSessionKeyRef.current !== sessionKey) {
        // The operator moved on, so there is no composer to roll back into. A
        // stated refusal means the draft belongs back under this session's key;
        // an unknown outcome might still have been delivered, so stay out of the
        // way rather than invite a resend.
        if (refused) saveComposerDraft(draftKey, text, pending);
        return;
      }
      if (refused) {
        setGhost(null);
        setRunning(wasRunning);
        setRunningSelection(wasRunning ? prevModel : null, wasRunning ? prevReasoningEffort : null);
        setInput(text);
        setFiles(pending);
      }
      notifyError(err, {
        title: t("session.compose.sendFailed"),
        fallback: t("error.generic"),
        message: composerActionErrorMessage(err, t),
      });
    } finally {
      if (submissionGateRef.current.finish(submission) && currentSessionKeyRef.current === sessionKey) setSending(false);
    }
  }

  async function enqueue() {
    const text = input.trim();
    if (!text && files.length === 0) return;
    const submission = submissionGateRef.current.begin(sessionKey);
    if (!submission) return;
    const prompt = text || "(see attachments)";
    const pending = files;
    const queueReconciler = queueReconcilerRef.current;
    setSending(true);
    setSendError(null);
    try {
      const attachments: { type: "file" | "image"; path: string; transferId?: string; size?: number; sha256?: string }[] = [];
      for (const file of pending) attachments.push({ type: isImage(file) ? "image" : "file", ...await uploadFile(file) });
      const commandId = crypto.randomUUID();
      await enqueueSessionFollowup(base, sid, {
        prompt,
        ...(attachments.length ? { attachments } : {}),
        ...(sessionPermissionMode ? { permissionMode: sessionPermissionMode } : {}),
        ...(overrideModel ? { model: overrideModel } : {}),
        ...(overrideReasoningEffort ? { reasoningEffort: overrideReasoningEffort } : {}),
        commandId,
      });
      // Peon owns FIFO order. Never insert the response optimistically; fetch the
      // authoritative list after acceptance (the stream change is a second guard).
      await queueReconciler?.reconcile();
      if (currentSessionKeyRef.current === sessionKey) {
        setInput("");
        setFiles([]);
        setStopNote(null);
      }
    } catch (err) {
      if (currentSessionKeyRef.current !== sessionKey) return;
      notifyError(err, {
        title: t("session.queue.addFailed"),
        fallback: t("error.generic"),
        message: composerActionErrorMessage(err, t),
      });
    } finally {
      if (submissionGateRef.current.finish(submission) && currentSessionKeyRef.current === sessionKey) setSending(false);
    }
  }

  async function removeQueuedItem(itemId: string) {
    if (removingQueueItems.has(itemId) || sendingQueueItems.has(itemId)) return;
    setRemovingQueueItems((current) => new Set(current).add(itemId));
    try {
      await removeWaitingQueueItem(
        itemId,
        (id) => removeSessionQueueItem(base, sid, id),
        () => queueReconcilerRef.current?.reconcile() ?? Promise.resolve(),
        (err) => notifyError(err, { title: t("session.queue.removeFailed"), fallback: t("error.generic") }),
      );
    } finally {
      setRemovingQueueItems((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  }

  async function steerQueuedItem(itemId: string) {
    if (sendingQueueItems.has(itemId) || removingQueueItems.has(itemId)) return;
    const queued = queueItems.find((item) => item.id === itemId);
    const wasRunning = running;
    const previousModel = runningModel;
    const previousReasoningEffort = runningReasoningEffort;
    setSendingQueueItems((current) => new Set(current).add(itemId));
    setSendError(null);
    setRunning(true);
    setRunningSelection(
      queued?.model || runningModel || sessionModel || (!sessionAgent ? catalog?.defaultModel : null) || null,
      queued?.reasoningEffort || runningReasoningEffort || sessionReasoningEffort || null,
    );
    setStopNote(null);
    try {
      const accepted = await sendWaitingQueueItemNow(
        itemId,
        (id) => steerSessionQueueItem(base, sid, id),
        () => queueReconcilerRef.current?.reconcile() ?? Promise.resolve(),
        (err) => notifyError(err, { title: t("session.queue.sendFailed"), fallback: t("error.generic") }),
      );
      if (accepted) onWorkStarted();
      else {
        setRunning(wasRunning);
        setRunningSelection(wasRunning ? previousModel : null, wasRunning ? previousReasoningEffort : null);
      }
    } finally {
      setSendingQueueItems((current) => {
        const next = new Set(current);
        next.delete(itemId);
        return next;
      });
    }
  }

  // Initial load and every later stream change use the same serialized GET path.
  // A reconnect's replayed change therefore also reconciles items that popped
  // while this browser was disconnected.
  useEffect(() => {
    setQueueItems([]);
    queueActivity.replace(sessionKey, []);
    setRemovingQueueItems(new Set());
    setSendingQueueItems(new Set());
    const reconciler = createQueueReconciler(
      () => getSessionQueue(base, sid),
      (items) => {
        queueActivity.replace(sessionKey, items);
        setQueueItems(items);
      },
    );
    queueReconcilerRef.current = reconciler;
    void reconciler.reconcile();
    return () => {
      reconciler.dispose();
      if (queueReconcilerRef.current === reconciler) queueReconcilerRef.current = null;
    };
  }, [base, notifyError, queueActivity, queueReconcilerRef, sessionKey, sid, t]);

  // `change` from the Peon is the fast path, but older Peons do not always emit
  // it when they automatically pop the next follow-up. While the widget still
  // shows queued work, periodically compare it with the authoritative queue so
  // a missed dequeue signal cannot leave a stale item on screen indefinitely.
  useEffect(() => {
    if (queueItems.length === 0) return;
    const reconcile = () => void queueReconcilerRef.current?.reconcile();
    const timer = window.setInterval(reconcile, 2_000);
    reconcile();
    return () => window.clearInterval(timer);
  }, [base, queueItems.length, queueReconcilerRef, sid]);

  return {
    input, setInput, files, setFiles, sending, sendError, setSendError, ghost,
    queueItems, removingQueueItems, steeringQueueItems: sendingQueueItems, filesEnabled, send, enqueue, removeQueuedItem, steerQueuedItem,
  };
}
