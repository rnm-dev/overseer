import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderTree, X } from "lucide-react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, isPeonNeedsUpdate, json } from "../../api";
import { useAuth } from "../../auth";
import { Button, FixedPaneHeader, titleize } from "../../ui";
import { useT } from "../../i18n";
import { useLiveSocket, type TailFrame } from "../../liveSocket";
import { usePeon } from "./context";
import { Composer } from "./Composer";
import { composerDraftKey, useComposerDraft } from "./drafts";
import { ModelSelect, ReasoningEffortSelect, modelLabel, optionMatches, providerForAgent, providerForModel, useModels } from "./models";
import {
  compactNum,
  flattenEvents,
  gapClass,
  latestRunSignal,
  orcishThinkingLabel,
  runSignalFromEvent,
  sig,
  usageBreakdown,
  usageFromEvent,
  workingActivity,
  type Ev,
  type MessageAttachment,
} from "./session/parsing";
import { ItemView, Working } from "./session/messageParts";
import { AttachmentPreview } from "./session/AttachmentPreview";
import { PreviewPanel, type PreviewTarget } from "./session/PreviewPanel";
import { ProjectFilePreviewModal, ProjectFileTree } from "./ProjectFiles";

// author: Viktor
// The transcript parsing/render pieces live in ./session/*; this file owns the
// page shell: data loading, the live tail, and the composer.

// Types the peon presents as visual content via the agent's Read tool → sent as
// { type: "image" }. Everything else is a { type: "file" } the agent Reads as text.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// Default upload sandbox — auto-set on a peon that has file transfer off, so
// attaching works without a manual Settings step. Uploads land under here.
const DEFAULT_FILE_ROOT = "/tmp/peon-files";
const isImage = (f: File) => IMAGE_TYPES.has(f.type);

export function PeonSessionDetail() {
  const t = useT();
  const { user } = useAuth();
  const { peon, base, wsId } = usePeon();
  const { sid = "" } = useParams();
  const { subscribe } = useLiveSocket();
  const navigate = useNavigate();
  const { catalog, supported: modelsSupported } = useModels(base);
  const sessionKey = `${peon.peonId}:${sid}`;

  const [history, setHistory] = useState<Ev[] | null>(null);
  const [live, setLive] = useState<Ev[]>([]);
  // Only show the loading spinner once switching has taken a beat — a fast
  // transcript fetch (the common case) should never flash it.
  const [showHistorySpinner, setShowHistorySpinner] = useState(false);
  useEffect(() => {
    setShowHistorySpinner(false);
    const id = setTimeout(() => setShowHistorySpinner(true), 1000);
    return () => clearTimeout(id);
  }, [sid]);

  // Session title + inline rename.
  const [title, setTitle] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [turnCount, setTurnCount] = useState<number | null>(null);
  const [sessionUsage, setSessionUsage] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [renameNote, setRenameNote] = useState<string | null>(null);


  // Session default model (null ⇒ follows the peon's global default). Comes
  // from the session record; refetched when a run ends (metaTick).
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [sessionAgent, setSessionAgent] = useState<string | null>(null);
  const [sessionReasoningEffort, setSessionReasoningEffort] = useState<string | null>(null);
  const [metaTick, setMetaTick] = useState(0);
  // Per-turn model override for the composer ("" ⇒ use the session/peon default).
  const [overrideModel, setOverrideModel] = useState("");
  const [overrideReasoningEffort, setOverrideReasoningEffort] = useState("");
  // React Router reuses this component when moving directly between sessions.
  // Overrides belong to one composer/session and must never leak into the next.
  useEffect(() => {
    setOverrideModel("");
    setOverrideReasoningEffort("");
  }, [sessionKey]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteNote, setDeleteNote] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Whether a run is currently active — gates the Stop button. Seeded from the
  // session record, flipped on by sending a followup, off by a `result` frame.
  // Key active-run state to the session so navigating between session routes can
  // never flash the previous session's indicator before the new metadata lands.
  const [activeRun, setActiveRun] = useState<{ sessionKey: string; running: boolean; model: string | null }>(() => ({
    sessionKey,
    running: false,
    model: null,
  }));
  const running = activeRun.sessionKey === sessionKey && activeRun.running;
  const runningModel = activeRun.sessionKey === sessionKey ? activeRun.model : null;
  const runRevisionRef = useRef<Map<string, number>>(new Map());
  const setRunning = useCallback((next: boolean) => {
    runRevisionRef.current.set(sessionKey, (runRevisionRef.current.get(sessionKey) ?? 0) + 1);
    setActiveRun((previous) => ({
      sessionKey,
      running: next,
      model: next && previous.sessionKey === sessionKey ? previous.model : null,
    }));
  }, [sessionKey]);
  const setRunningModel = useCallback((model: string | null) => {
    setActiveRun((previous) => ({
      sessionKey,
      running: previous.sessionKey === sessionKey && previous.running,
      model,
    }));
  }, [sessionKey]);
  const [stopping, setStopping] = useState(false);
  const [stopNote, setStopNote] = useState<string | null>(null);

  // Composer.
  const [input, setInput] = useComposerDraft(composerDraftKey(wsId, peon.peonId, sid));
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [filesEnabled, setFilesEnabled] = useState<boolean | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [sentAttachmentPreview, setSentAttachmentPreview] = useState<MessageAttachment | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<PreviewTarget | null>(null);
  const [previewPinned, setPreviewPinned] = useState(false);
  const [projectFilePreview, setProjectFilePreview] = useState<{ path: string; size?: number } | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  useEffect(() => setProjectFilePreview(null), [sessionKey, projectKey]);
  useEffect(() => setFilesOpen(false), [sessionKey]);
  useEffect(() => {
    document.documentElement.classList.toggle("session-files-open", filesOpen);
    return () => document.documentElement.classList.remove("session-files-open");
  }, [filesOpen]);
  const previewPinnedRef = useRef(false);
  useEffect(() => { previewPinnedRef.current = previewPinned; }, [previewPinned]);
  const [composerNode, setComposerNode] = useState<HTMLDivElement | null>(null);
  const [composerHeight, setComposerHeight] = useState(112);
  const sessionProvider = providerForAgent(catalog, sessionAgent) ?? (!sessionAgent ? (providerForAgent(catalog, catalog?.defaultAgent) ?? providerForModel(catalog, sessionModel ?? catalog?.defaultModel)) : null);
  // Capabilities can change after a peon update or provider settings change.
  // Never keep displaying (and later submit) a stale value that is no longer in
  // the active provider's menu.
  useEffect(() => {
    if (!sessionProvider) return;
    setOverrideModel((value) => value && !sessionProvider.models.some((option) => optionMatches(option, value)) ? "" : value);
    setOverrideReasoningEffort((value) => value && !sessionProvider.reasoningEfforts.some((option) => optionMatches(option, value)) ? "" : value);
  }, [sessionProvider]);
  useEffect(() => {
    if (!composerNode) return;
    const measure = () => setComposerHeight(composerNode.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composerNode);
    return () => observer.disconnect();
  }, [composerNode]);
  // Pending optimistic echoes: text → count. Armed in send() BEFORE the POST (the
  // peon echoes the message back over the tail, and that frame can land while the
  // request is still in flight — the guard must already be set or it doubles). A
  // count, not a set, so the same text sent twice is dropped exactly twice.
  const sentTextsRef = useRef<Map<string, number>>(new Map());
  // The initial /transcript snapshot and the live tail overlap: the tail attaches
  // just before the snapshot is taken, so events in that window arrive on both
  // channels. These drive a filter that skips the leading run of tail events that
  // merely replay the snapshot, until the first genuinely-new event.
  const historyReadyRef = useRef(false);
  // Signatures of every event already shown (history + everything appended live).
  // The live tail is deduped against this continuously — not just at the initial
  // snapshot boundary — so a peon replay after a WS reconnect or the same frame
  // arriving twice can't re-append. Distinct events have distinct JSON
  // (uuid/timestamps), so this never collapses two genuinely-different messages.
  const seenRef = useRef<Set<string>>(new Set());
  const pendingLiveRef = useRef<Ev[]>([]);

  // Match a committed user-message event to an optimistic bubble, regardless of
  // whether it arrived through the tail, transcript polling, or the initial
  // snapshot. Keeping this at the ingestion boundary avoids a race where the
  // poll renders the echo before the tail-specific guard gets a chance to drop it.
  const consumeOptimisticEcho = useCallback((ev: Ev): boolean => {
    if (ev.type !== "user_message" || typeof ev.text !== "string") return false;
    const n = sentTextsRef.current.get(ev.text) ?? 0;
    if (n === 0) return false;
    if (n === 1) sentTextsRef.current.delete(ev.text);
    else sentTextsRef.current.set(ev.text, n - 1);
    seenRef.current.add(sig(ev));
    return true;
  }, []);

  // Append a live tail event, dropping the leading run that just replays the
  // snapshot. Once a tail event isn't found in the snapshot the overlap is past and
  // everything after is appended verbatim — so a legitimately repeated message
  // later in the session is never dropped.
  const pushLive = useCallback((ev: Ev): boolean => {
    const s = sig(ev);
    if (seenRef.current.has(s)) return false; // snapshot/tail overlap or a reconnect replay
    seenRef.current.add(s);
    setLive((prev) => [...prev, ev]);
    return true;
  }, []);

  // Run state follows accepted transcript events, never raw transport frames.
  // This makes starts from another operator visible while preventing reconnect
  // replays from applying an old turn's terminal result to the current turn.
  const pushFreshEvent = useCallback((ev: Ev) => {
    if (consumeOptimisticEcho(ev)) return;
    if (!pushLive(ev)) return;
    const signal = runSignalFromEvent(ev);
    if (signal === "running") setRunning(true);
    else if (signal === "idle") {
      setRunning(false);
      setMetaTick((n) => n + 1);
    }
  }, [consumeOptimisticEcho, pushLive, setRunning]);

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
  async function uploadFile(f: File): Promise<string> {
    const safe = f.name.replace(/[^\w.\-]+/g, "_") || "file";
    const buf = await f.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await api<{ path?: string }>(`${base}/files/uploads/${encodeURIComponent(sid)}/${encodeURIComponent(safe)}`, {
      method: "PUT",
      body: buf,
      headers: { "content-type": "application/octet-stream", "peon-content-sha256": hex },
    });
    return res.path || `uploads/${sid}/${safe}`;
  }

  async function send() {
    const text = input.trim();
    if ((!text && files.length === 0) || sending) return;
    const prompt = text || "(see attachments)";
    const pending = files;
    const wasRunning = running;
    const prevModel = runningModel;
    setSending(true);
    setSendError(null);
    // Optimistically echo + ARM the dedup guard BEFORE any await. The peon echoes the
    // message back over the live tail, and that frame can arrive while the upload/POST
    // is still in flight — if the guard isn't set yet it slips through and doubles.
    const echo: Ev = {
      type: "user_message",
      text: prompt,
      // The committed Peon echo is deliberately consumed below to prevent a
      // duplicate bubble, so the optimistic event remains the rendered source
      // of truth. Give it the same authorship metadata plus a client send time.
      author: user?.email || user?.githubLogin || undefined,
      createdAt: Date.now(),
      attachments: pending.map((f) => ({ type: isImage(f) ? "image" : "file", name: f.name, size: f.size })),
    };
    sentTextsRef.current.set(prompt, (sentTextsRef.current.get(prompt) ?? 0) + 1);
    stickToBottomRef.current = true; // sending always jumps back to the bottom, even if scrolled up reading history
    setLive((prev) => [...prev, echo]);
    setRunning(true);
    setRunningModel(overrideModel || sessionModel || (!sessionAgent ? catalog?.defaultModel : null) || null);
    setStopNote(null);
    setInput("");
    setFiles([]);
    try {
      // Upload each file to the sandbox, then send native attachments[] (peon
      // presents images as visual content to the agent via its Read tool).
      const attachments: { type: "file" | "image"; path: string }[] = [];
      for (const f of pending) attachments.push({ type: isImage(f) ? "image" : "file", path: await uploadFile(f) });
      setLive((prev) => prev.map((event) => event === echo ? {
        ...event,
        attachments: attachments.map((attachment, i) => ({ ...attachment, name: pending[i]?.name, size: pending[i]?.size })),
      } : event));
      const body: { prompt: string; attachments?: typeof attachments; model?: string; reasoningEffort?: string } = { prompt };
      if (attachments.length) body.attachments = attachments;
      if (overrideModel) body.model = overrideModel; // one-shot override for this turn
      if (overrideReasoningEffort) body.reasoningEffort = overrideReasoningEffort;
      const request = json(body);
      request.headers = { "Peon-Request-Id": crypto.randomUUID() };
      await api(`${base}/sessions/${encodeURIComponent(sid)}/followup`, request);
    } catch (err) {
      // Send failed — roll back the optimistic echo, guard count, and composer.
      setLive((prev) => prev.filter((e) => e !== echo));
      const n = sentTextsRef.current.get(prompt) ?? 0;
      if (n <= 1) sentTextsRef.current.delete(prompt);
      else sentTextsRef.current.set(prompt, n - 1);
      setRunning(wasRunning);
      setRunningModel(wasRunning ? prevModel : null);
      setInput(text);
      setFiles(pending);
      const code = err instanceof ApiError ? err.code : "";
      if (err instanceof ApiError && (code === "RESUME_IN_PROGRESS" || err.status === 409)) setSendError(t("session.compose.busy"));
      else if (code === "FILES_DISABLED") setSendError(t("session.compose.filesDisabledHint"));
      else if (code === "ATTACHMENT_TOO_LARGE") setSendError(t("session.compose.tooLarge"));
      else if (code === "UNSUPPORTED_MEDIA_TYPE") setSendError(t("session.compose.badType"));
      else if (code === "UNKNOWN_ATTACHMENT_PATH" || code === "PATH_ESCAPE") setSendError(t("session.compose.uploadFailed"));
      else if (isPeonNeedsUpdate(err)) setSendError(t("peon.unsupported"));
      else setSendError(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let alive = true;
    const runRevision = runRevisionRef.current.get(sessionKey) ?? 0;
    api<{ title?: string | null; projectKey?: string | null; status?: string | null; agent?: string | null; backendSessionId?: string | null; model?: string | null; reasoningEffort?: string | null; turnCount?: number | null; usage?: unknown }>(
      `${base}/sessions/${encodeURIComponent(sid)}`,
    )
      .then((s) => {
        if (!alive) return;
        setTitle(s.title ?? null);
        setDraft(s.title ?? "");
        setEditing(false);
        setProjectKey(s.projectKey ?? null);
        setTurnCount(typeof s.turnCount === "number" ? s.turnCount : null);
        setSessionUsage(s.usage ?? null);
        setSessionAgent(s.agent ?? null);
        setSessionReasoningEffort(s.reasoningEffort ?? null);
        // Do not let a metadata request that started before a local/live run
        // transition overwrite that newer transition when its response arrives.
        if ((runRevisionRef.current.get(sessionKey) ?? 0) === runRevision) {
          setRunning(s.status === "running");
          if (s.status === "running") setRunningModel(s.model ?? null);
        }
        setSessionModel(s.model ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base, sid, sessionKey, metaTick, setRunning, setRunningModel]);

  async function remove() {
    setDeleting(true);
    setDeleteNote(null);
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
      navigate("..", { relative: "path" });
    } catch (err) {
      // 409 ⇒ still running (cancel first); 404 on an older peon ⇒ needs update.
      setDeleteNote(err instanceof ApiError && err.status === 409 ? t("session.delete.running") : isPeonNeedsUpdate(err) ? t("peon.unsupported") : t("error.generic"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  async function stop() {
    setStopping(true);
    setStopNote(null);
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}/cancel`, { method: "POST" });
      setRunning(false);
    } catch (err) {
      // 409 ⇒ nothing active to cancel; 404 on an older peon ⇒ needs update.
      setStopNote(err instanceof ApiError && err.status === 409 ? t("session.stop.nothing") : isPeonNeedsUpdate(err) ? t("peon.unsupported") : t("error.generic"));
    } finally {
      setStopping(false);
    }
  }

  async function saveName() {
    if (savingName) return;
    setSavingName(true);
    setRenameNote(null);
    const next = draft.trim() ? draft.trim() : null; // empty clears the title
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "PATCH", body: JSON.stringify({ title: next }) });
      setTitle(next);
      setDraft(next ?? "");
      setEditing(false);
    } catch (err) {
      // Older peons predate PATCH /sessions/:id → 404; surface "needs update".
      setRenameNote(isPeonNeedsUpdate(err) ? t("peon.unsupported") : t("error.generic"));
    } finally {
      setSavingName(false);
    }
  }

  // Initial transcript. Also the reset point for the snapshot/tail overlap state:
  // switching sessions clears the live buffer and re-seeds the overlap filter.
  useEffect(() => {
    let alive = true;
    historyReadyRef.current = false;
    seenRef.current = new Set();
    pendingLiveRef.current = [];
    setHistory(null);
    setLive([]);
    const ready = (events: Ev[]) => {
      // A send can happen while this request is in flight. If its committed echo
      // is already in the snapshot, retain the optimistic bubble and omit only
      // that matching snapshot event.
      const visibleEvents = events.filter((ev) => !consumeOptimisticEcho(ev));
      setHistory(visibleEvents);
      seenRef.current = new Set(events.map(sig));
      historyReadyRef.current = true;
      // A turn started between the metadata request and this snapshot may already
      // be present in history, making its buffered tail copy a duplicate. Preserve
      // that positive activity signal; terminal state still comes from metadata or
      // a fresh result frame, so an old completed snapshot cannot hide a newer run.
      if (latestRunSignal(events) === "running") setRunning(true);
      // Replay any tail frames that landed before the snapshot, through the same
      // overlap filter now that the baseline exists.
      const pending = pendingLiveRef.current;
      pendingLiveRef.current = [];
      for (const ev of pending) pushFreshEvent(ev);
    };
    api<{ events?: Ev[] } | Ev[]>(`${base}/sessions/${encodeURIComponent(sid)}/transcript`)
      .then((r) => alive && ready(Array.isArray(r) ? r : (r.events ?? [])))
      .catch(() => alive && ready([]));
    return () => {
      alive = false;
    };
  }, [base, sid, consumeOptimisticEcho, pushFreshEvent, setRunning]);

  // Live tail over the WebSocket — same event shape as the transcript.
  useEffect(() => {
    const onFrame = (f: TailFrame) => {
      // Tail availability is transport state, not run state. The socket layer
      // auto-resubscribes, and an active run must stay visibly active meanwhile.
      if (f.event === "tailEnd" || f.event === "tailError") return;
      let ev: Ev;
      try {
        ev = JSON.parse(f.data) as Ev;
      } catch {
        ev = { type: "_raw", text: f.data };
      }
      // Preview is a normalized Peon event, never inferred from assistant text.
      // Only the live stream auto-opens it; transcript/history rendering below
      // merely exposes an explicit Open preview action. A pinned artifact keeps
      // its place when another live preview arrives.
      if (ev.type === "preview" && typeof ev.path === "string" && ev.path) {
        setArtifactPreview((current) => previewPinnedRef.current && current ? current : {
          path: ev.path!,
          author: typeof ev.author === "string" ? ev.author : undefined,
          createdAt: typeof ev.createdAt === "number" ? ev.createdAt : undefined,
        });
      }
      // Tail frames can arrive before the transcript snapshot resolves; buffer them
      // so the overlap filter has a baseline to compare against.
      if (!historyReadyRef.current) {
        pendingLiveRef.current.push(ev);
        return;
      }
      pushFreshEvent(ev);
    };
    const unsub = subscribe(peon.peonId, sid, onFrame);
    return unsub;
  }, [peon.peonId, sid, subscribe, pushFreshEvent]);

  // The WebSocket tail is the fast path, but a Peon's long-lived SSE stream can
  // occasionally stay open without delivering frames (proxy/network half-open).
  // Reconcile the transcript while work is active so the page self-heals instead
  // of showing "Thinking" forever until a manual refresh. pushFreshEvent uses the
  // same signature set as the tail, so frames received through both paths render
  // exactly once.
  useEffect(() => {
    if (!running) return;
    let alive = true;
    let inFlight = false;
    const reconcileTranscript = async () => {
      if (!alive || inFlight || !historyReadyRef.current) return;
      inFlight = true;
      try {
        const result = await api<{ events?: Ev[] } | Ev[]>(`${base}/sessions/${encodeURIComponent(sid)}/transcript`);
        if (!alive) return;
        const events = Array.isArray(result) ? result : (result.events ?? []);
        for (const ev of events) pushFreshEvent(ev);
      } catch {
        // The live tail may still be healthy; a transient poll failure should not
        // disturb it or replace the transcript with an error state.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(reconcileTranscript, 2_000);
    void reconcileTranscript();
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [base, sid, running, pushFreshEvent]);

  // Close the kebab menu on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Whether the operator is (still) parked at the bottom of the page — only
  // then does a new frame get to autoscroll. Scrolling up to read history
  // clears this and it stays clear until they scroll back down themselves, so
  // a live update never yanks them back to the bottom mid-read.
  const stickToBottomRef = useRef(true);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  useEffect(() => {
    const NEAR_BOTTOM_PX = 80;
    const onScroll = () => {
      const { scrollY, innerHeight } = window;
      const { scrollHeight } = document.documentElement;
      const atBottom = scrollHeight - (scrollY + innerHeight) <= NEAR_BOTTOM_PX;
      stickToBottomRef.current = atBottom;
      setShowScrollToBottom(!atBottom);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    stickToBottomRef.current = true;
    setShowScrollToBottom(false);
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
  }, []);

  // Autoscroll to the newest output, but only while the operator is parked at
  // the bottom — see stickToBottomRef above. rAF so freshly-laid-out content
  // (code blocks, tool output, images) is measured before we jump, or we'd
  // land short.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (stickToBottomRef.current) window.scrollTo({ top: document.documentElement.scrollHeight });
    });
    return () => cancelAnimationFrame(id);
  }, [history, live]);

  // What the agent is doing right now, from the freshest event (live wins over history).
  const lastEvent = live.length ? live[live.length - 1] : history?.length ? history[history.length - 1] : undefined;
  const working = workingActivity(lastEvent);
  // Flattened render list — pairs each tool_use with its later tool_result so it
  // renders as a single row (see flattenEvents).
  const items = useMemo(() => flattenEvents([...(history ?? []), ...live], t), [history, live, t]);
  // Untitled session ⇒ fall back to the opening line of the first user message,
  // so the header reads as something recognizable instead of a generic label.
  const firstUserMessage = useMemo(() => {
    const first = items.find((i) => i.kind === "user");
    return first ? first.text.split("\n")[0].trim() || null : null;
  }, [items]);
  const transcriptTurns = useMemo(
    () => [...(history ?? []), ...live].reduce((sum, ev) => sum + (ev.type === "result" && typeof ev.num_turns === "number" ? ev.num_turns : 0), 0),
    [history, live],
  );
  const turnTotal = turnCount ?? transcriptTurns;
  const usageSummary = useMemo(() => {
    const fromSession = usageBreakdown(sessionUsage);
    if (fromSession) return fromSession;
    // No structured total yet (session still running, or peon hasn't reported
    // one) — each turn's own usage already reflects the whole context resent up
    // to that point, so summing across turns would multiply-count it. The
    // freshest turn's usage is the best available snapshot.
    const events = [...(history ?? []), ...live];
    for (let i = events.length - 1; i >= 0; i--) {
      const u = usageFromEvent(events[i]);
      if (u) return u;
    }
    return null;
  }, [history, live, sessionUsage]);
  const showHeaderStats = turnTotal > 0 || !!usageSummary;
  const cancelRename = () => {
    setDraft(title ?? "");
    setRenameNote(null);
    setEditing(false);
  };

  return (
    <div className="min-w-0">
      <FixedPaneHeader>
        <div className="space-y-1.5 px-3 py-2.5 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {projectKey && (
                <Link
                  to={`/peons/${peon.peonId}/projects/${encodeURIComponent(projectKey)}`}
                  className="flex-none whitespace-nowrap font-display text-sm font-semibold text-forge transition-colors hover:text-fel-bright"
                  title={t("session.project")}
                >
                  {titleize(projectKey)}
                </Link>
              )}
              <div
                className={`flex min-w-0 flex-1 items-center rounded transition-colors ${editing ? "bg-iron-800/70" : ""}`}
                onBlur={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null) && !savingName) cancelRename();
                }}
              >
                <input
                  value={draft}
                  placeholder={firstUserMessage || t("session.untitled")}
                  aria-label={t("session.renamePlaceholder")}
                  title={title ?? firstUserMessage ?? undefined}
                  disabled={savingName}
                  onFocus={(e) => {
                    setRenameNote(null);
                    setEditing(true);
                    e.currentTarget.select();
                  }}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveName();
                    if (e.key === "Escape") cancelRename();
                  }}
                  className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 font-display text-sm font-semibold text-bone outline-none placeholder:text-bone placeholder:opacity-100 disabled:cursor-wait"
                />
                {editing && (
                  <div className="ml-1 flex shrink-0 items-center gap-0.5 pr-0.5">
                    <button
                      type="button"
                      className="grid size-5 place-items-center rounded text-xs text-fel-bright transition-colors hover:bg-fel/15 disabled:opacity-50"
                      title={t("session.rename.save")}
                      aria-label={t("session.rename.save")}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void saveName()}
                      disabled={savingName}
                    >
                      ✓
                    </button>
                    <button
                      type="button"
                      className="grid size-5 place-items-center rounded text-sm text-bone-dim transition-colors hover:bg-iron-700 hover:text-bone disabled:opacity-50"
                      title={t("action.cancel")}
                      aria-label={t("action.cancel")}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={cancelRename}
                      disabled={savingName}
                    >
                      ×
                    </button>
                  </div>
                )}
              </div>
            </div>

            {showHeaderStats && (
              <div className="hidden flex-none items-center gap-1.5 whitespace-nowrap font-mono text-xs text-bone-faint sm:flex">
                {turnTotal > 0 && <span>{t("session.chat.turns", { n: turnTotal })}</span>}
                {turnTotal > 0 && usageSummary && <span>·</span>}
                {usageSummary?.costUsd !== undefined && <span>${usageSummary.costUsd.toFixed(2)}</span>}
                {usageSummary?.costUsd !== undefined && usageSummary.output > 0 && <span>·</span>}
                {usageSummary && usageSummary.output > 0 && (
                  <span
                    title={`${t("peon.stats.inputTokens")} ${compactNum.format(usageSummary.input)} · ${t("peon.stats.cacheWrite")} ${compactNum.format(usageSummary.cacheCreate)} · ${t("peon.stats.cacheRead")} ${compactNum.format(usageSummary.cacheRead)}`}
                  >
                    {compactNum.format(usageSummary.output)} {t("peon.stats.outputTokens").toLowerCase()}
                  </span>
                )}
              </div>
            )}

            <button
              type="button"
              title={t("session.files.open")}
              aria-label={t("session.files.open")}
              aria-expanded={filesOpen}
              onClick={() => setFilesOpen((open) => !open)}
              className={`hidden size-7 flex-none place-items-center rounded transition-colors lg:grid ${filesOpen ? "bg-iron-800 text-fel-bright" : "text-bone-dim hover:bg-iron-800 hover:text-bone"}`}
            >
              <FolderTree size={16} aria-hidden />
            </button>

            <div className="relative flex-none" ref={menuRef}>
              <button
                type="button"
                title={t("session.menu")}
                onClick={() => setMenuOpen((o) => !o)}
                className="flex items-center rounded p-1 text-bone-dim transition-colors hover:bg-iron-800 hover:text-bone"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <circle cx="12" cy="5" r="1.75" />
                  <circle cx="12" cy="12" r="1.75" />
                  <circle cx="12" cy="19" r="1.75" />
                </svg>
              </button>
              {menuOpen && (
                <div className="absolute right-0 top-full z-30 mt-1 w-40 overflow-hidden rounded-lg border border-iron-800 bg-iron-950 py-1 shadow-lg">
                  <button
                    className="block w-full px-3 py-1.5 text-left font-mono text-xs text-blood transition-colors hover:bg-blood/10"
                    onClick={() => {
                      setDeleteNote(null);
                      setConfirmDelete(true);
                      setMenuOpen(false);
                    }}
                  >
                    {t("session.delete")}
                  </button>
                </div>
              )}
            </div>
          </div>

          {confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-blood">{t("session.delete.confirm")}</span>
              <Button size="sm" variant="iron" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                {t("action.cancel")}
              </Button>
              <button className="btn btn-sm !border-blood/50 !text-blood hover:!bg-blood/10" onClick={remove} disabled={deleting}>
                {deleting ? t("session.delete.deleting") : t("session.delete.confirmYes")}
              </button>
            </div>
          )}
          {renameNote && <div className="font-mono text-xs text-blood">{renameNote}</div>}
          {deleteNote && <div className="font-mono text-xs text-blood">⚠ {deleteNote}</div>}
          {stopNote && <div className="font-mono text-xs text-ember">⚠ {stopNote}</div>}
        </div>
      </FixedPaneHeader>

      {/* transcript — flows into the page; the body scrolls it */}
      <div className="min-w-0 overflow-x-hidden pt-4" style={{ paddingBottom: composerHeight }}>
        {history === null ? (
          showHistorySpinner && (
            <div className="grid min-h-[40vh] place-items-center">
              <div className="forge-spin" />
            </div>
          )
        ) : history.length === 0 && live.length === 0 && !running ? (
          <p className="text-center font-mono text-sm text-bone-faint">{t("session.empty")}</p>
        ) : (
          <div>
            {items.map((item, i) => (
              <div key={item.key} className={i === 0 ? "" : gapClass(items[i - 1].kind === "user", item.kind === "user")}>
                <ItemView item={item} t={t} onOpenPreview={(p) => setArtifactPreview({ path: p.path, author: p.author, createdAt: p.createdAt })} onOpenAttachment={setSentAttachmentPreview} />
              </div>
            ))}
            {running && (
              <div
                data-session-running-row
                className={items.length === 0 ? "" : gapClass(items[items.length - 1].kind === "user", false)}
              >
                <Working
                  label={
                    working.key === "session.working.thinking"
                      ? orcishThinkingLabel(`working:${JSON.stringify(lastEvent ?? {})}`)
                      : t(working.key, working.name ? { name: working.name } : undefined)
                  }
                  model={modelLabel(catalog, runningModel)}
                  onStop={stop}
                  stopping={stopping}
                  stopLabel={t("session.stop")}
                  stoppingLabel={t("session.stop.stopping")}
                />
              </div>
            )}
          </div>
        )}
        <div className="h-2 sm:h-5" aria-hidden="true" />
      </div>

      {filesOpen && createPortal(
        <aside className="session-files-pane fixed bottom-3 right-3 z-30 hidden w-80 min-h-0 flex-col overflow-hidden rounded-xl bg-iron-900 shadow-2xl lg:flex" style={{ top: "calc(var(--fixed-pane-header-height, 49px) + 0.75rem)" }} aria-label={t("session.files.title")}>
          <div className="flex flex-none items-center gap-2 px-3 py-3">
            <FolderTree size={16} className="flex-none text-fel-deep" aria-hidden />
            <div className="min-w-0 flex-1 truncate font-display text-xs font-semibold text-bone-dim">{t("session.files.title")}</div>
            <button type="button" onClick={() => setFilesOpen(false)} className="rounded p-1 text-bone-faint transition-colors hover:bg-iron-800 hover:text-bone" aria-label={t("session.files.close")}>
              <X size={16} />
            </button>
          </div>
          {projectKey ? (
            <ProjectFileTree
              filesBase={`${base}/projects/${encodeURIComponent(projectKey)}/files`}
              activePath={projectFilePreview?.path}
              onOpenFile={(path, size) => setProjectFilePreview({ path, size })}
              className="flex-1"
            />
          ) : (
            <p className="p-3 font-mono text-xs leading-relaxed text-bone-faint">{t("session.files.noProject")}</p>
          )}
        </aside>,
        document.body,
      )}

      {showScrollToBottom &&
        createPortal(
          <div
            className="session-scroll-control pointer-events-none fixed left-0 right-0 z-[41] flex justify-center md:left-[var(--peon-sidebar-width)]"
            style={{ bottom: composerHeight + 12 }}
          >
            <button
              type="button"
              onClick={scrollToBottom}
              className="pointer-events-auto grid size-10 place-items-center rounded-full border border-iron-700 bg-iron-950/95 text-bone shadow-lg backdrop-blur transition-colors hover:border-ember/60 hover:bg-iron-900 hover:text-ember focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember/70"
              title={t("session.scrollToBottom")}
              aria-label={t("session.scrollToBottom")}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
          </div>,
          document.body,
        )}

      {/* composer — portaled to <body> so it's truly viewport-fixed (the .reveal
          transform would otherwise make `fixed` resolve against it), pinned to the
          bottom, boxed, and slightly wider than the chat column */}
      {createPortal(
        <div ref={setComposerNode} className="session-composer fixed bottom-0 left-0 right-0 z-40 bg-gradient-to-t from-void via-void to-transparent pt-6 md:left-[var(--peon-sidebar-width)]">
          <div className="mx-auto max-w-[76rem] px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-[max(1rem,env(safe-area-inset-bottom))]">
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={send}
              placeholder={t("session.compose.placeholder")}
              submitTitle={t("session.compose.send")}
              disabled={sending}
              autoFocus
              files={files}
              onFilesChange={setFiles}
              onPreviewFile={setAttachmentPreview}
              filesEnabled={filesEnabled}
              error={sendError}
              onErrorChange={setSendError}
              rightExtra={
                modelsSupported && catalog && catalog.providers.length > 0 ? (
                  <>
                    <ModelSelect
                      key={`model:${sessionKey}`}
                      provider={sessionProvider}
                      value={overrideModel || sessionModel || ""}
                      onChange={setOverrideModel}
                      label={t("session.compose.model")}
                      className="model-select-compact"
                      defaultLabel={sessionModel ? modelLabel(catalog, sessionModel) ?? sessionModel : t("model.default")}
                      defaultId={sessionModel ?? undefined}
                      allowClear={!sessionModel}
                    />
                    <ReasoningEffortSelect
                      key={`effort:${sessionKey}`}
                      provider={sessionProvider}
                      value={overrideReasoningEffort}
                      onChange={setOverrideReasoningEffort}
                      label={t("session.compose.reasoningEffort")}
                      className="model-select-compact"
                      defaultLabel={sessionReasoningEffort ? sessionProvider?.reasoningEfforts.find((effort) => effort.id === sessionReasoningEffort)?.label ?? sessionReasoningEffort : t("model.default")}
                    />
                  </>
                ) : undefined
              }
            />
          </div>
        </div>,
        document.body,
      )}
      {attachmentPreview &&
        createPortal(
          <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/85 p-8" onClick={() => setAttachmentPreview(null)}>
            <img src={attachmentPreview} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg" />
          </div>,
          document.body,
        )}
      {sentAttachmentPreview && <AttachmentPreview base={base} attachment={sentAttachmentPreview} onClose={() => setSentAttachmentPreview(null)} />}
      {artifactPreview && (
        <PreviewPanel
          base={base}
          sessionId={sid}
          target={artifactPreview}
          pinned={previewPinned}
          onPinnedChange={setPreviewPinned}
          onClose={() => {
            setArtifactPreview(null);
            setPreviewPinned(false);
          }}
          t={t}
        />
      )}
      {projectKey && projectFilePreview && (
        <ProjectFilePreviewModal
          filesBase={`${base}/projects/${encodeURIComponent(projectKey)}/files`}
          path={projectFilePreview.path}
          size={projectFilePreview.size}
          onClose={() => setProjectFilePreview(null)}
        />
      )}
    </div>
  );
}
