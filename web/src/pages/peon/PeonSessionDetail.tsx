import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError, isPeonNeedsUpdate } from "../../api";
import { useAuth } from "../../auth";
import { useT } from "../../i18n";
import { useLiveSocket } from "../../liveSocket";
import { usePeon } from "./context";
import { modelLabel, optionMatches, providerForAgent, providerForModel, useModels } from "./models";
import {
  flattenEvents,
  gapClass,
  orcishThinkingLabel,
  usageBreakdown,
  usageFromEvent,
  workingActivity,
  type MessageAttachment,
} from "./session/parsing";
import { ItemView, Working } from "./session/messageParts";
import { createQueueReconciler } from "./session/queue";
import type { PreviewTarget } from "./session/PreviewPanel";
import { useSessionTranscript } from "./session/useSessionTranscript";
import { useSessionComposer } from "./session/useSessionComposer";
import { SessionHeader } from "./session/SessionHeader";
import { SessionComposerDock } from "./session/SessionComposerDock";
import { SessionOverlays } from "./session/SessionOverlays";
import { useScrollToBottom } from "./session/useScrollToBottom";
import { nextSessionAfterDeletion } from "./session/nextSession";
import { isSuccessfulRunResult, playPeonSound } from "../../peonSounds";

// author: Viktor
// The transcript parsing/render pieces live in ./session/*; this file owns the
// page shell: data loading, the live tail, and the composer.

const FILE_PANES_STORAGE_KEY = "overseer.open-session-file-panes";

function storedOpenFilePanes(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FILE_PANES_STORAGE_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function storeFilePaneState(pageKey: string, open: boolean) {
  try {
    const pages = storedOpenFilePanes();
    if (open) pages.add(pageKey); else pages.delete(pageKey);
    window.localStorage.setItem(FILE_PANES_STORAGE_KEY, JSON.stringify([...pages]));
  } catch {
    // Storage may be disabled; the pane still works for the current page visit.
  }
}

export function PeonSessionDetail() {
  const t = useT();
  const { user } = useAuth();
  const { peon, base, wsId, orderedSessionIds, sessionHref, sessionsHomeHref, onSessionDeleted } = usePeon();
  const { sid = "" } = useParams();
  const { subscribe, viewersFor } = useLiveSocket();
  const navigate = useNavigate();
  const { catalog, supported: modelsSupported } = useModels(base);
  const sessionKey = `${peon.peonId}:${sid}`;
  const transcriptPaginationSupported = peon.capabilities.includes("transcript-pagination-v1");
  const filePanePageKey = `${wsId}:${sessionKey}`;
  const currentSessionKeyRef = useRef(sessionKey);
  // Update during render, not in an effect: a request from the previous route can
  // settle in the small render→effect window and must not mutate the new session.
  currentSessionKeyRef.current = sessionKey;

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
  const [sessionPermissionMode, setSessionPermissionMode] = useState<string | null>(null);
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
  const metadataStatusRef = useRef<Map<string, string | null>>(new Map());
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
  const suppressCompletionSoundRef = useRef(false);

  const queueReconcilerRef = useRef<ReturnType<typeof createQueueReconciler> | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [sentAttachmentPreview, setSentAttachmentPreview] = useState<MessageAttachment | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<PreviewTarget | null>(null);
  const [previewPinned, setPreviewPinned] = useState(false);
  const [projectFilePreview, setProjectFilePreview] = useState<{ path: string; size?: number } | null>(null);
  const [filesOpen, setFilesOpen] = useState(() => storedOpenFilePanes().has(filePanePageKey));
  useEffect(() => setProjectFilePreview(null), [sessionKey, projectKey]);
  useEffect(() => setFilesOpen(storedOpenFilePanes().has(filePanePageKey)), [filePanePageKey]);
  useEffect(() => {
    document.documentElement.classList.toggle("session-files-open", filesOpen);
    return () => document.documentElement.classList.remove("session-files-open");
  }, [filesOpen]);
  const changeFilesOpen = useCallback((open: boolean) => {
    setFilesOpen(open);
    storeFilePaneState(filePanePageKey, open);
  }, [filePanePageKey]);
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
  const onSnapshotRunning = useCallback(() => {
    setActiveRun((previous) => ({
      sessionKey,
      running: true,
      model: previous.sessionKey === sessionKey ? previous.model : null,
    }));
  }, [sessionKey]);
  const onRunFinished = useCallback((event?: { type?: string; is_error?: boolean }) => {
    setRunning(false);
    setMetaTick((value) => value + 1);
    if (!event || !isSuccessfulRunResult(event)) return;
    if (suppressCompletionSoundRef.current) {
      suppressCompletionSoundRef.current = false;
      return;
    }
    playPeonSound("complete");
  }, [setRunning]);
  const onWorkStarted = useCallback(() => {
    suppressCompletionSoundRef.current = false;
    playPeonSound("start");
  }, []);
  const onQueueChange = useCallback(() => {
    void queueReconcilerRef.current?.reconcile();
  }, []);
  const onPreview = useCallback((target: PreviewTarget) => {
    setArtifactPreview(target);
  }, []);
  const {
    history,
    live,
    orderedLive,
    showHistorySpinner,
    hasOlder,
    loadingOlder,
    olderLoadError,
    loadOlder,
    setLive,
    pendingEchoesRef,
    historyReadyRef,
    tailHighWaterRef,
    refreshTranscript,
  } = useSessionTranscript({
    base,
    sid,
    sessionKey,
    peonId: peon.peonId,
    paginationSupported: transcriptPaginationSupported,
    running,
    subscribe,
    metadataStatusRef,
    previewPinnedRef,
    onRunningChange: setRunning,
    onSnapshotRunning,
    onRunFinished,
    onQueueChange,
    onPreview,
  });

  const prependAnchorRef = useRef<{ sessionKey: string; height: number; scrollY: number } | null>(null);
  const oldestHistoryEventId = history?.[0]?.eventId;
  const handleLoadOlder = useCallback(async () => {
    prependAnchorRef.current = { sessionKey, height: document.documentElement.scrollHeight, scrollY: window.scrollY };
    const loaded = await loadOlder();
    if (!loaded && prependAnchorRef.current?.sessionKey === sessionKey) prependAnchorRef.current = null;
  }, [loadOlder, sessionKey]);
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current;
    if (!anchor || anchor.sessionKey !== sessionKey) return;
    const addedHeight = document.documentElement.scrollHeight - anchor.height;
    window.scrollTo({ top: anchor.scrollY + Math.max(0, addedHeight) });
    prependAnchorRef.current = null;
  }, [oldestHistoryEventId, sessionKey]);

  const stickToBottomRef = useRef(true);
  const {
    input, setInput, files, setFiles, sending, sendError, setSendError,
    queueItems, removingQueueItems, filesEnabled, send, enqueue, removeQueuedItem,
  } = useSessionComposer({
    base,
    sid,
    sessionKey,
    wsId,
    peonId: peon.peonId,
    user,
    t,
    running,
    runningModel,
    sessionModel,
    sessionAgent,
    sessionPermissionMode,
    overrideModel,
    overrideReasoningEffort,
    catalog,
    currentSessionKeyRef,
    queueReconcilerRef,
    pendingEchoesRef,
    historyReadyRef,
    tailHighWaterRef,
    stickToBottomRef,
    setLive,
    setRunning,
    setRunningModel,
    setStopNote,
    refreshTranscript,
    onWorkStarted,
  });


  useEffect(() => {
    let alive = true;
    const runRevision = runRevisionRef.current.get(sessionKey) ?? 0;
    api<{ title?: string | null; projectKey?: string | null; status?: string | null; agent?: string | null; backendSessionId?: string | null; model?: string | null; reasoningEffort?: string | null; permissionMode?: string | null; turnCount?: number | null; usage?: unknown }>(
      `${base}/sessions/${encodeURIComponent(sid)}`,
    )
      .then((s) => {
        if (!alive) return;
        metadataStatusRef.current.set(sessionKey, s.status ?? null);
        setTitle(s.title ?? null);
        setDraft(s.title ?? "");
        setEditing(false);
        setProjectKey(s.projectKey ?? null);
        setTurnCount(typeof s.turnCount === "number" ? s.turnCount : null);
        setSessionUsage(s.usage ?? null);
        setSessionAgent(s.agent ?? null);
        setSessionReasoningEffort(s.reasoningEffort ?? null);
        setSessionPermissionMode(s.permissionMode ?? null);
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
    const nextSessionId = nextSessionAfterDeletion(orderedSessionIds, sid);
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
      onSessionDeleted?.(peon.peonId, sid);
      setConfirmDelete(false);
      setDeleting(false);
      navigate(
        nextSessionId
          ? sessionHref?.(peon.peonId, nextSessionId) ?? `/peons/${peon.peonId}/sessions/${encodeURIComponent(nextSessionId)}`
          : sessionsHomeHref ?? `/peons/${peon.peonId}`,
        { replace: true },
      );
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
    suppressCompletionSoundRef.current = true;
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}/cancel`, { method: "POST" });
      setRunning(false);
      playPeonSound("stop");
    } catch (err) {
      suppressCompletionSoundRef.current = false;
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

  const { showScrollToBottom, scrollToBottom } = useScrollToBottom(stickToBottomRef, history, live);
  // What the agent is doing right now, from the freshest event (live wins over history).
  const lastEvent = orderedLive.length ? orderedLive[orderedLive.length - 1] : history?.length ? history[history.length - 1] : undefined;
  const working = workingActivity(lastEvent);
  // Flattened render list — pairs each tool_use with its later tool_result so it
  // renders as a single row (see flattenEvents).
  const items = useMemo(() => flattenEvents([...(history ?? []), ...orderedLive], t), [history, orderedLive, t]);
  // Untitled session ⇒ fall back to the opening line of the first user message,
  // so the header reads as something recognizable instead of a generic label.
  const firstUserMessage = useMemo(() => {
    const first = items.find((i) => i.kind === "user");
    return first ? first.text.split("\n")[0].trim() || null : null;
  }, [items]);
  const transcriptTurns = useMemo(
    () => [...(history ?? []), ...orderedLive].reduce((sum, ev) => sum + (ev.type === "result" && typeof ev.num_turns === "number" ? ev.num_turns : 0), 0),
    [history, orderedLive],
  );
  const turnTotal = turnCount ?? transcriptTurns;
  const usageSummary = useMemo(() => {
    const fromSession = usageBreakdown(sessionUsage);
    if (fromSession) return fromSession;
    // No structured total yet (session still running, or peon hasn't reported
    // one) — each turn's own usage already reflects the whole context resent up
    // to that point, so summing across turns would multiply-count it. The
    // freshest turn's usage is the best available snapshot.
    const events = [...(history ?? []), ...orderedLive];
    for (let i = events.length - 1; i >= 0; i--) {
      const u = usageFromEvent(events[i]);
      if (u) return u;
    }
    return null;
  }, [history, orderedLive, sessionUsage]);
  const cancelRename = () => {
    setDraft(title ?? "");
    setRenameNote(null);
    setEditing(false);
  };

  return (
    <div className="min-w-0">
      <SessionHeader
        peonId={peon.peonId}
        projectKey={projectKey}
        title={title}
        draft={draft}
        setDraft={setDraft}
        editing={editing}
        setEditing={setEditing}
        savingName={savingName}
        renameNote={renameNote}
        setRenameNote={setRenameNote}
        firstUserMessage={firstUserMessage}
        turnTotal={turnTotal}
        usageSummary={usageSummary}
        filesOpen={filesOpen}
        changeFilesOpen={changeFilesOpen}
        confirmDelete={confirmDelete}
        setConfirmDelete={setConfirmDelete}
        deleting={deleting}
        deleteNote={deleteNote}
        setDeleteNote={setDeleteNote}
        stopNote={stopNote}
        saveName={saveName}
        cancelRename={cancelRename}
        remove={remove}
        viewers={viewersFor(peon.peonId, sid)}
      />
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
            {hasOlder && (
              <div className="mb-5 flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleLoadOlder()}
                  disabled={loadingOlder}
                  className="rounded border border-iron-700 bg-iron-950 px-3 py-2 font-mono text-xs text-bone-muted transition-colors hover:border-ember/60 hover:text-bone disabled:cursor-wait disabled:opacity-60"
                >
                  {loadingOlder ? t("session.history.loading") : t("session.history.loadOlder")}
                </button>
                {olderLoadError && <p className="font-mono text-xs text-red-300">{t("session.history.failed")}</p>}
              </div>
            )}
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

      <SessionComposerDock
        setComposerNode={setComposerNode}
        queueItems={queueItems}
        removingQueueItems={removingQueueItems}
        removeQueuedItem={removeQueuedItem}
        input={input}
        setInput={setInput}
        running={running}
        enqueue={enqueue}
        send={send}
        sending={sending}
        files={files}
        setFiles={setFiles}
        setAttachmentPreview={setAttachmentPreview}
        filesEnabled={filesEnabled}
        sendError={sendError}
        setSendError={setSendError}
        modelsSupported={modelsSupported}
        catalog={catalog}
        sessionKey={sessionKey}
        sessionProvider={sessionProvider}
        overrideModel={overrideModel}
        setOverrideModel={setOverrideModel}
        sessionModel={sessionModel}
        overrideReasoningEffort={overrideReasoningEffort}
        setOverrideReasoningEffort={setOverrideReasoningEffort}
        sessionReasoningEffort={sessionReasoningEffort}
      />
      <SessionOverlays
        base={base}
        sid={sid}
        projectKey={projectKey}
        filesOpen={filesOpen}
        projectFilePreview={projectFilePreview}
        setProjectFilePreview={setProjectFilePreview}
        attachmentPreview={attachmentPreview}
        setAttachmentPreview={setAttachmentPreview}
        sentAttachmentPreview={sentAttachmentPreview}
        setSentAttachmentPreview={setSentAttachmentPreview}
        artifactPreview={artifactPreview}
        setArtifactPreview={setArtifactPreview}
        previewPinned={previewPinned}
        setPreviewPinned={setPreviewPinned}
      />
    </div>
  );
}
