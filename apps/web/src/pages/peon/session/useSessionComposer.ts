import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { api, ApiError, isPeonNeedsUpdate, json } from "../../../api";
import type { User } from "../../../auth";
import type { Translate } from "../../../i18n";
import { useNotifications } from "../../../notifications";
import { composerDraftKey, useComposerDraft, useComposerDraftFiles } from "../drafts";
import { attachmentUploadPath } from "../fileLinks";
import type { ModelsCatalog } from "../models";
import type { Ev } from "./parsing";
import { createQueueReconciler, enqueueSessionFollowup, getSessionQueue, removeSessionQueueItem, removeWaitingQueueItem, sendSessionQueueItemNow, sendWaitingQueueItemNow, type QueueActivityTracker, type QueueItem } from "./queue";
import { createSubmissionGate } from "./submissionGate";
import type { PendingEcho } from "./transcriptMerge";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const DEFAULT_FILE_ROOT = "/tmp/peon-files";
const isImage = (file: File) => IMAGE_TYPES.has(file.type);

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

interface Args {
  base: string;
  sid: string;
  sessionKey: string;
  wsId: string;
  peonId: string;
  user: User | null;
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
  pendingEchoesRef: MutableRefObject<PendingEcho[]>;
  historyReadyRef: MutableRefObject<boolean>;
  tailHighWaterRef: MutableRefObject<number>;
  stickToBottomRef: MutableRefObject<boolean>;
  setLive: Dispatch<SetStateAction<Ev[]>>;
  setRunning: (running: boolean) => void;
  setRunningSelection: (model: string | null, reasoningEffort: string | null) => void;
  setStopNote: Dispatch<SetStateAction<string | null>>;
  onWorkStarted: () => void;
}

export function useSessionComposer({
  base, sid, sessionKey, wsId, peonId, user, t, running, runningModel,
  runningReasoningEffort, sessionModel, sessionAgent, sessionReasoningEffort,
  sessionPermissionMode, overrideModel,
  overrideReasoningEffort, catalog, currentSessionKeyRef, queueReconcilerRef,
  queueActivity,
  pendingEchoesRef, historyReadyRef, tailHighWaterRef, stickToBottomRef,
  setLive, setRunning, setRunningSelection, setStopNote, onWorkStarted,
}: Args) {
  const { notifyError } = useNotifications();
  const draftKey = composerDraftKey(wsId, peonId, sid);
  const [input, setInput] = useComposerDraft(draftKey);
  const [files, setFiles] = useComposerDraftFiles(draftKey);
  const [sending, setSending] = useState(false);
  const submissionGateRef = useRef(createSubmissionGate());
  const [sendError, setSendError] = useState<string | null>(null);
  const [queueItems, setQueueItems] = useState<QueueItem[]>([]);
  const [removingQueueItems, setRemovingQueueItems] = useState<Set<string>>(new Set());
  const [sendingQueueItems, setSendingQueueItems] = useState<Set<string>>(new Set());
  const [filesEnabled, setFilesEnabled] = useState<boolean | null>(null);
  useEffect(() => { setSending(false); }, [sessionKey]);

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
    // Optimistically echo + ARM the dedup guard BEFORE any await. The peon echoes the
    // message back over the live tail, and that frame can arrive while the upload/POST
    // is still in flight — if the guard isn't set yet it slips through and doubles.
    const clientId = crypto.randomUUID();
    const createdAt = Date.now();
    const baselineTailId = historyReadyRef.current ? tailHighWaterRef.current : null;
    const author = user?.email || undefined;
    const echo: Ev = {
      type: "user_message",
      text: prompt,
      // The committed Peon echo is deliberately consumed below to prevent a
      // duplicate bubble, so the optimistic event remains the rendered source
      // of truth. Give it the same authorship metadata plus a client send time.
      author,
      authorEmail: user?.email || undefined,
      authorGithubLogin: user?.githubLogin || undefined,
      authorAvatarUrl: user?.avatarUrl || undefined,
      commandId: clientId,
      createdAt,
      attachments: pending.map((f) => ({ type: isImage(f) ? "image" : "file", name: f.name, size: f.size })),
      _clientId: clientId,
      _optimistic: true,
      _baselineTailId: baselineTailId,
    };
    pendingEchoesRef.current.push({ clientId, text: prompt, author, createdAt, baselineTailId });
    stickToBottomRef.current = true; // sending always jumps back to the bottom, even if scrolled up reading history
    setLive((prev) => [...prev, echo]);
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
      if (currentSessionKeyRef.current === sessionKey) {
        setLive((prev) => prev.map((event) => event._clientId === clientId ? {
          ...event,
          attachments: attachments.map((attachment, i) => ({ ...attachment, name: pending[i]?.name, size: pending[i]?.size })),
        } : event));
      }
      const body: { prompt: string; attachments?: typeof attachments; model?: string; reasoningEffort?: string } = { prompt };
      if (attachments.length) body.attachments = attachments;
      if (overrideModel) body.model = overrideModel; // becomes the session default after acceptance
      if (overrideReasoningEffort) body.reasoningEffort = overrideReasoningEffort;
      const request = json(body);
      request.headers = { "Peon-Request-Id": clientId };
      await api(`${base}/sessions/${encodeURIComponent(sid)}/followup`, request);
      if (currentSessionKeyRef.current === sessionKey) onWorkStarted();
    } catch (err) {
      if (currentSessionKeyRef.current !== sessionKey) return;
      // If its SSE event already arrived, Peon committed the message even if the
      // HTTP response was lost. Keep it visible and do not invite an accidental
      // resend. Otherwise roll the optimistic row and composer back.
      const stillPending = pendingEchoesRef.current.some((item) => item.clientId === clientId);
      if (!stillPending) return;
      pendingEchoesRef.current = pendingEchoesRef.current.filter((item) => item.clientId !== clientId);
      setLive((prev) => prev.filter((event) => event._clientId !== clientId));
      setRunning(wasRunning);
      setRunningSelection(wasRunning ? prevModel : null, wasRunning ? prevReasoningEffort : null);
      setInput(text);
      setFiles(pending);
      notifyError(err, {
        title: t("session.compose.sendFailed"),
        fallback: t("error.generic"),
        message: composerActionErrorMessage(err, t),
      });
    } finally {
      if (submissionGateRef.current.finish(submission) && currentSessionKeyRef.current === sessionKey) setSending(false);
    }
  }

  async function enqueue(startNow: boolean) {
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
        startNow,
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

  async function sendQueuedItemNow(itemId: string) {
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
        (id) => sendSessionQueueItemNow(base, sid, id),
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
      (error) => {
        if (!isPeonNeedsUpdate(error)) notifyError(error, {
          title: t("session.queue.loadFailed"),
          fallback: t("error.generic"),
        });
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
    input, setInput, files, setFiles, sending, sendError, setSendError,
    queueItems, removingQueueItems, sendingQueueItems, filesEnabled, send, enqueue, removeQueuedItem, sendQueuedItemNow,
  };
}
