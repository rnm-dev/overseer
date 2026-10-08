import { refreshSessionPins } from "./useSessionPins";
import { ProviderLogin } from "../stats/ProviderLoginPanel";
import { signedOut } from "../stats/providerLogin";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type MouseEvent, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { ArrowRight, GitFork, LoaderCircle, MoreHorizontal } from "lucide-react";
import { api, ApiError, isPeonNeedsUpdate } from "../../shared/api";
import { shouldAcknowledgeAttention } from "./sessionAttentionRead";
import { useI18n } from "../../shared/i18n";
import { useLiveSocket } from "../../realtime/liveSocket";
import { useAuth } from "../auth/auth";
import { usePeon } from "../fleet/context";
import { defaultModelId, modelLabel, providerForSession, reasoningEffortLabel, useModels } from "../settings/models";
import {
  flattenEvents,
  gapPaddingClass,
  usageBreakdown,
  usageFromEvent,
  workingActivity,
  type Item,
  type MessageAttachment,
} from "./parsing";
import { ItemView, UserBubble, Working } from "./messageParts";
import { createQueueActivityTracker, createQueueReconciler } from "./queue";
import { combineVisibleTranscriptEvents } from "./transcriptMerge";
import { transcriptFollowOutput, transcriptFollowsOutput, transcriptShowsJumpToNewest } from "./transcriptFollow";
import type { PreviewTarget } from "./PreviewPanel";
import { useSessionTranscript } from "./useSessionTranscript";
import { useSessionComposer, type ComposerGhost } from "./useSessionComposer";
import { selectedTextReplyForRow, SELECTED_TEXT_REPLY_CAPABILITY, type SelectedTextReply } from "./selectedTextReply";
import { captureSelectionSnapshot, SelectedTextReplyContextMenu, type SelectionSnapshot } from "./SelectedTextReplyContextMenu";
import { SessionHeader, sessionHeaderIdentityData } from "./SessionHeader";
import { COMPOSER_FOOTER_PADDING, SessionComposerDock, composerFooterHeight } from "./SessionComposerDock";
import { SessionOverlays } from "./SessionOverlays";
import { nextSessionAfterDeletion } from "./nextSession";
import { stopOutcome } from "./stopOutcome";
import {
  createTranscriptVirtualWindow,
  updateTranscriptVirtualWindow,
} from "./transcriptVirtualization";
import { lockSessionDocument } from "./sessionViewport";
import { loadToolDisplayMode } from "./sessionToolDisplay";
import { isSuccessfulRunResult, onSelectedSoundPackChange, playPeonSound, playWorkSound, stopWorkSound } from "../../realtime/peonSounds";
import { PluginInquiryCard } from "./PluginInquiryCard";
import { DropdownMenu, menuItemClass } from "../../shared/ui";
import { sessionLineage } from "./sessionBranch";
import { useSessionBranch } from "./useSessionBranch";
import { inquiryInsertionIndex, PLUGIN_INQUIRY_CAPABILITY, usePluginInquiries, type PluginInstallInquiry } from "./pluginInquiries";
import { indexedRunAssumptionDelay, shouldSeedIndexedRun } from "./runStatus";
import { SessionSharingPanel } from "./SessionSharingPanel";
import { activeMentionQuery, insertMention, mentionsRouteToPeople, remapMentions, removeMention, CONTEXT_MESSAGES_CAPABILITY, type ComposerMention, type MentionPrincipal } from "./contextMentions";
import { clearComposerSelectionIfUnchanged, composerDraftKey, selectionAfterAcceptance, type ComposerSelectionDraft, useComposerSelectionDraft } from "./drafts";
import { createContinuationSession, lastUnexecutedUserPrompt, sessionContinuationFailure, type SessionContinuationFailure } from "./sessionContinuationRecovery";

// author: Viktor
// The transcript parsing/render pieces live in ./session/*; this file owns the
// page shell: data loading, the live tail, and the composer.

const FILE_PANES_STORAGE_KEY = "overseer.open-session-file-panes";

type VirtualTranscriptRow =
  | { key: string; kind: "lineage"; sourceSessionId: string; relation: "branch" | "subsession"; title: string | null; paddingClass: string }
  | { key: string; kind: "item"; item: Item; paddingClass: string }
  | { key: string; kind: "ghost"; ghost: ComposerGhost; paddingClass: string }
  | { key: string; kind: "inquiry"; inquiry: PluginInstallInquiry; paddingClass: string }
  | { key: string; kind: "recovery"; failure: SessionContinuationFailure; paddingClass: string }
  | { key: string; kind: "working"; paddingClass: string }
  | { key: string; kind: "footer"; height: number };

function TranscriptListHeader() {
  return <div className="h-12" aria-hidden="true" />;
}

function BranchMessageMenu({ branching, disabled, error, onBranch, t }: {
  branching: boolean;
  disabled: boolean;
  error: string | null;
  onBranch: () => void;
  t: ReturnType<typeof useI18n>["t"];
}) {
  return (
    <div className="mt-1 flex items-center gap-2 pl-0.5">
      <DropdownMenu
        label={t("session.branch.menu")}
        buttonClassName="grid h-6 w-6 place-items-center rounded text-ink-faint transition-colors hover:bg-surface-raised hover:text-ink disabled:opacity-40"
        menuAlignClassName="left-0"
        menuWidthClassName="w-36"
        trigger={<MoreHorizontal size={15} aria-hidden />}
      >
        {(close) => <button type="button" role="menuitem" disabled={disabled || branching} className={`${menuItemClass()} !flex items-center gap-2`} onClick={() => { close(); onBranch(); }}>
          {branching ? <LoaderCircle size={13} className="animate-spin" aria-hidden /> : <GitFork size={13} aria-hidden />}
          {branching ? t("session.branch.creating") : t("session.branch.action")}
        </button>}
      </DropdownMenu>
      {error && <span role="alert" className="font-body text-[0.625rem] text-danger">{error}</span>}
    </div>
  );
}

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
  const { peon } = usePeon();
  const { sid = "" } = useParams();
  return <PeonSessionDetailPage key={`${peon.peonId}:${sid}`} />;
}

function PeonSessionDetailPage() {
  const { locale, t } = useI18n();
  const { user } = useAuth();
  const { peon, base, isOwner, wsId, orderedSessionIds, selectedSession, sessionHref, sessionsHomeHref, onSessionDeleted, onSessionRunningChange } = usePeon();
  const { sid = "" } = useParams();
  const { subscribe, subscribeMentionAttention, viewersFor } = useLiveSocket();
  const navigate = useNavigate();
  const { catalog, supported: modelsSupported } = useModels(base);
  const sessionKey = `${peon.peonId}:${sid}`;
  const transcriptPaginationSupported = peon.capabilities.includes("transcript-pagination-v1");
  const selectedTextRepliesSupported = peon.capabilities.includes(SELECTED_TEXT_REPLY_CAPABILITY);
  const pluginInquiriesSupported = peon.capabilities.includes(PLUGIN_INQUIRY_CAPABILITY);
  const contextMessagesSupported = peon.capabilities.includes(CONTEXT_MESSAGES_CAPABILITY);
  const filePanePageKey = `${wsId}:${sessionKey}`;
  const currentSessionKeyRef = useRef(sessionKey);
  const [simpleTools] = useState(() => loadToolDisplayMode() === "simple");
  const [sharingOpen, setSharingOpen] = useState(false);
  const [mentionPrincipals, setMentionPrincipals] = useState<MentionPrincipal[]>([]);
  const [mentions, setMentions] = useState<ComposerMention[]>([]);
  // Where the picker looks for its `@`, and where the caret is put back after a
  // person is inserted into the middle of an already written sentence.
  const [composerCaret, setComposerCaret] = useState<number | null>(null);
  const [caretRequest, setCaretRequest] = useState<{ position: number; seq: number } | null>(null);
  const caretSeqRef = useRef(0);
  const [mentionAttentionIds, setMentionAttentionIds] = useState<Set<string>>(new Set());
  const attentionReadInFlightRef = useRef<string | null>(null);
  // Update during render, not in an effect: a request from the previous route can
  // settle in the small render→effect window and must not mutate the new session.
  currentSessionKeyRef.current = sessionKey;

  // iOS Safari keeps html/body as a second scroll surface even when the fixed
  // route shell is clipped. Freeze that root surface for the lifetime of the
  // transcript; Virtuoso remains the only element that handles vertical pan.
  useLayoutEffect(() => lockSessionDocument(document), []);

  // Clearing the unread mark means "the operator has seen this". Only claim that
  // while the tab is actually in front of them; otherwise wait until it is, so a
  // run that finishes in a backgrounded tab keeps its amber edge.
  // The unread mark flips exactly when a run ends, so anything keyed to this
  // callback's identity would be rebuilt at that moment — including the
  // transcript's fetch and tail effects, which must not be torn down while the
  // run they are reporting on is ending. Read the flag through a ref instead.
  const attentionUnreadRef = useRef(selectedSession?.attentionUnread);
  attentionUnreadRef.current = selectedSession?.attentionUnread;
  const markAttentionRead = useCallback(() => {
    if (!sid || !shouldAcknowledgeAttention(attentionUnreadRef.current, document.visibilityState, document.hasFocus())) return;
    if (attentionReadInFlightRef.current === sessionKey) return;
    attentionReadInFlightRef.current = sessionKey;
    void api(`${base}/sessions/${encodeURIComponent(sid)}/attention/read`, { method: "POST" }).catch(() => {
      if (attentionReadInFlightRef.current === sessionKey) attentionReadInFlightRef.current = null;
    });
  }, [base, sessionKey, sid]);

  useEffect(() => {
    if (selectedSession?.attentionUnread !== true) attentionReadInFlightRef.current = null;
  }, [selectedSession?.attentionUnread, sessionKey]);

  useEffect(() => {
    markAttentionRead();
    const onPresence = () => markAttentionRead();
    document.addEventListener("visibilitychange", onPresence);
    window.addEventListener("focus", onPresence);
    return () => {
      document.removeEventListener("visibilitychange", onPresence);
      window.removeEventListener("focus", onPresence);
    };
  }, [markAttentionRead, selectedSession?.attentionUnread]);

  useEffect(() => {
    if (!contextMessagesSupported) {
      setMentionPrincipals([]);
      setMentions([]);
      setMentionAttentionIds(new Set());
      return;
    }
    let alive = true;
    void Promise.all([
      api<{ principals?: MentionPrincipal[] }>(`${base}/sessions/${encodeURIComponent(sid)}/mention-principals`),
      api<{ attention?: Array<{ eventId: string; unread: boolean }> }>(`${base}/sessions/${encodeURIComponent(sid)}/mention-attention`),
    ]).then(([roster, attention]) => {
      if (!alive) return;
      setMentionPrincipals(roster.principals ?? []);
      setMentionAttentionIds(new Set((attention.attention ?? []).filter((item) => item.unread).map((item) => item.eventId)));
    }).catch(() => undefined);
    const unsubscribe = subscribeMentionAttention((attention) => {
      if (attention.peonId !== peon.peonId || attention.sessionId !== sid) return;
      setMentionAttentionIds((current) => {
        const next = new Set(current);
        if (attention.unread) next.add(attention.eventId); else next.delete(attention.eventId);
        return next;
      });
    });
    return () => { alive = false; unsubscribe(); };
  }, [base, contextMessagesSupported, peon.peonId, sid, subscribeMentionAttention]);

  // Session title + inline rename.
  const [title, setTitle] = useState<string | null>(null);
  const [openingMessage, setOpeningMessage] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectRoot, setProjectRoot] = useState<string | null>(null);
  const [loadedMetadataKey, setLoadedMetadataKey] = useState<string | null>(null);
  const [turnCount, setTurnCount] = useState<number | null>(null);
  const [sessionUsage, setSessionUsage] = useState<unknown>(null);
  const [lineage, setLineage] = useState<{ sourceSessionId: string; relation: "branch" | "subsession"; title: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [renameNote, setRenameNote] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  // Sidebar mutations update the shared indexed summary immediately. Mirror a
  // renamed selected session into the header without waiting for the next
  // metadata refresh or durable catalog event.
  const indexedTitle = selectedSession?.title;
  useEffect(() => {
    if (indexedTitle === undefined) return;
    setTitle(indexedTitle);
    if (!editing) setDraft(indexedTitle ?? "");
  }, [editing, indexedTitle, sessionKey]);


  // Session default model (null ⇒ follows the peon's global default). Comes
  // from the session record; refetched once when a run ends (metaTick).
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [sessionAgent, setSessionAgent] = useState<string | null>(null);
  const [sessionReasoningEffort, setSessionReasoningEffort] = useState<string | null>(null);
  const [sessionPermissionMode, setSessionPermissionMode] = useState<string | null>(null);
  const [metaTick, setMetaTick] = useState(0);
  // Pending selections live beside the composer text rather than becoming a
  // browser-wide preference. Empty means inherit; it never asks Peon to unpin.
  const selectionDraftKey = composerDraftKey(wsId, peon.peonId, sid);
  const [selectionDraft, setSelectionDraft] = useComposerSelectionDraft(selectionDraftKey);
  const overrideModel = selectionDraft.model;
  const overrideReasoningEffort = selectionDraft.reasoningEffort;
  const setOverrideModel = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    setSelectionDraft((current) => ({
      ...current,
      model: typeof action === "function" ? action(current.model) : action,
    }));
  }, [setSelectionDraft]);
  const setOverrideReasoningEffort = useCallback<Dispatch<SetStateAction<string>>>((action) => {
    setSelectionDraft((current) => ({
      ...current,
      reasoningEffort: typeof action === "function" ? action(current.reasoningEffort) : action,
    }));
  }, [setSelectionDraft]);
  const onQueuedSelectionRestored = useCallback((queued: Pick<ComposerSelectionDraft, "model" | "reasoningEffort">) => {
    setSelectionDraft((current) => ({ ...current, ...queued }));
  }, [setSelectionDraft]);
  const [replyTo, setReplyTo] = useState<SelectedTextReply | null>(null);
  const [replyContextMenu, setReplyContextMenu] = useState<{
    replyTo: SelectedTextReply;
    row: HTMLDivElement;
    selection: SelectionSnapshot;
    x: number;
    y: number;
    linkHref: string | null;
  } | null>(null);
  // React Router reuses this component when moving directly between sessions.
  // Reply metadata is route-local; model choices hydrate under their own draft
  // key above and therefore cannot leak into the next session.
  useEffect(() => {
    setReplyTo(null);
  }, [sessionKey]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteNote, setDeleteNote] = useState<string | null>(null);

  // Whether a run is currently active — gates the Stop button. Seeded from the
  // session record, flipped on by sending a followup, off by a `result` frame.
  // Key active-run state to the session so navigating between session routes can
  // never flash the previous session's indicator before the new metadata lands.
  const [activeRun, setActiveRun] = useState<{ sessionKey: string; running: boolean; model: string | null; reasoningEffort: string | null; assumedAt: number | null }>(() => ({
    sessionKey,
    // The indexed summary is already on screen with the sidebar. Use it as the
    // cache-first answer instead of hiding activity until the direct metadata
    // request (or a transcript run signal) wins its independent request race.
    running: selectedSession?.status === "running",
    model: null,
    reasoningEffort: null,
    assumedAt: selectedSession?.status === "running" ? Date.now() : null,
  }));
  const running = activeRun.sessionKey === sessionKey && activeRun.running;
  const controlReadScope = user?.email.toLowerCase() ?? "";
  const pluginInquiries = usePluginInquiries(base, sid, pluginInquiriesSupported, running, controlReadScope);
  const refreshPluginInquiries = pluginInquiries.refresh;
  // A run only exists while the Peon holding it is connected. If it dies mid-run
  // nothing can report the ending, so stop claiming live work rather than
  // animating forever; the record is re-read (and the index healed) as soon as
  // the Peon answers again.
  const controlConnected = peon.controlConnected ?? peon.online;
  const liveWork = running && controlConnected;
  const { branching, branchError, branchSession } = useSessionBranch({
    base,
    sessionId: sid,
    sessionKey,
    peonId: peon.peonId,
    sessionHref,
    navigate,
    disabled: liveWork,
    t,
  });
  const runningModel = activeRun.sessionKey === sessionKey ? activeRun.model : null;
  const runningReasoningEffort = activeRun.sessionKey === sessionKey ? activeRun.reasoningEffort : null;
  const runRevisionRef = useRef<Map<string, number>>(new Map());
  const observedRunMetadataRefreshRef = useRef<Set<string>>(new Set());
  const metadataStatusRef = useRef<Map<string, string | null>>(new Map());
  // A Peon that refuses a cancel with SESSION_NOT_RUNNING has told us something
  // stronger than its own session record does: that record can be left at
  // "running" by a run whose process vanished, and re-reading it would keep
  // resurrecting the indicator we just cleared. So the refusal outranks the
  // record until the session produces live work again.
  const refutedRunRef = useRef<Set<string>>(new Set());
  // A run this page only inferred from the transcript, with nothing having
  // confirmed it. The inference reads "the newest event is not a result", which
  // is also true of a turn whose process vanished, so it must never outlive the
  // record read that was supposed to settle it.
  const unconfirmedRunRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // The sidebar page can finish hydrating after this route mounts. Promote
    // its running summary only while no direct/live evidence has arrived; the
    // metadata GET and tail remain authoritative and can immediately clear it.
    if (!shouldSeedIndexedRun({
      indexedStatus: selectedSession?.status,
      metadataStatusKnown: metadataStatusRef.current.has(sessionKey),
      runRevision: runRevisionRef.current.get(sessionKey) ?? 0,
      refuted: refutedRunRef.current.has(sessionKey),
    })) return;
    setActiveRun((previous) => previous.sessionKey === sessionKey && previous.running
      ? previous
      : { sessionKey, running: true, model: null, reasoningEffort: null, assumedAt: Date.now() });
  }, [selectedSession?.status, sessionKey]);
  const setRunning = useCallback((next: boolean) => {
    // Only a live signal — a sent follow-up or a tail frame — turns a run back
    // on, and that is exactly what makes the Peon's record trustworthy again.
    if (next) refutedRunRef.current.delete(sessionKey);
    unconfirmedRunRef.current.delete(sessionKey);
    runRevisionRef.current.set(sessionKey, (runRevisionRef.current.get(sessionKey) ?? 0) + 1);
    setActiveRun((previous) => ({
      sessionKey,
      running: next,
      model: next && previous.sessionKey === sessionKey ? previous.model : null,
      reasoningEffort: next && previous.sessionKey === sessionKey ? previous.reasoningEffort : null,
      assumedAt: null,
    }));
    onSessionRunningChange?.(peon.peonId, sid, next, Date.now());
  }, [onSessionRunningChange, peon.peonId, sessionKey, sid]);
  const refreshMetadataForObservedRun = useCallback(() => {
    if (observedRunMetadataRefreshRef.current.has(sessionKey)) return;
    observedRunMetadataRefreshRef.current.add(sessionKey);
    setMetaTick((value) => value + 1);
  }, [sessionKey]);
  const onLiveRunningChange = useCallback((next: boolean) => {
    if (next) refreshMetadataForObservedRun();
    else observedRunMetadataRefreshRef.current.delete(sessionKey);
    setRunning(next);
  }, [refreshMetadataForObservedRun, sessionKey, setRunning]);
  // Model and effort always travel together: they describe the same turn, and
  // the activity indicator reports both.
  const setRunningSelection = useCallback((model: string | null, reasoningEffort: string | null) => {
    setActiveRun((previous) => ({
      sessionKey,
      running: previous.sessionKey === sessionKey && previous.running,
      model,
      reasoningEffort,
      assumedAt: previous.sessionKey === sessionKey ? previous.assumedAt : null,
    }));
  }, [sessionKey]);
  useEffect(() => {
    if (activeRun.sessionKey !== sessionKey || !activeRun.running) return;
    const delay = indexedRunAssumptionDelay(Date.now(), activeRun.assumedAt);
    if (delay === null) return;
    const timer = window.setTimeout(() => {
      setActiveRun((current) => current.sessionKey === sessionKey && current.assumedAt !== null
        ? { ...current, running: false, model: null, reasoningEffort: null, assumedAt: null }
        : current);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [activeRun.assumedAt, activeRun.running, activeRun.sessionKey, sessionKey]);
  const [stopping, setStopping] = useState(false);
  const [stopNote, setStopNote] = useState<string | null>(null);
  const suppressCompletionSoundRef = useRef(false);
  useEffect(() => {
    if (!liveWork) stopWorkSound();
    const unsubscribe = onSelectedSoundPackChange(stopWorkSound);
    return () => {
      unsubscribe();
      stopWorkSound();
    };
  }, [liveWork, sessionKey]);

  const queueReconcilerRef = useRef<ReturnType<typeof createQueueReconciler> | null>(null);
  const queueActivityRef = useRef(createQueueActivityTracker());
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(null);
  const [sentAttachmentPreview, setSentAttachmentPreview] = useState<MessageAttachment | null>(null);
  const [artifactPreview, setArtifactPreview] = useState<PreviewTarget | null>(null);
  const [previewPinned, setPreviewPinned] = useState(false);
  const [projectFilePreview, setProjectFilePreview] = useState<{ path: string; size?: number; viewerUrl?: string } | null>(null);
  const [filesOpen, setFilesOpen] = useState(() => storedOpenFilePanes().has(filePanePageKey));
  const [fileRefreshRevision, setFileRefreshRevision] = useState(0);
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
  const [composerHeight, setComposerHeight] = useState(COMPOSER_FOOTER_PADDING);
  const sessionProvider = providerForSession(catalog, sessionAgent, sessionModel);
  const onSelectionAccepted = useCallback((submitted: Pick<ComposerSelectionDraft, "model" | "reasoningEffort">) => {
    const submittedSelection: ComposerSelectionDraft = { agent: "", ...submitted };
    clearComposerSelectionIfUnchanged(selectionDraftKey, submittedSelection);
    setSelectionDraft((current) => selectionAfterAcceptance(current, submittedSelection));
    // Peon owns the accepted pin. Re-read it after either immediate delivery or
    // durable queue acceptance so the next draft starts from server truth.
    if (currentSessionKeyRef.current === sessionKey) setMetaTick((value) => value + 1);
  }, [selectionDraftKey, sessionKey, setSelectionDraft]);
  useEffect(() => {
    if (!composerNode) return;
    const measure = () => setComposerHeight(composerFooterHeight(composerNode.getBoundingClientRect().height, window.innerHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(composerNode);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [composerNode]);
  const onSnapshotRunning = useCallback(() => {
    // A transcript whose last event is a run signal describes the same stuck
    // record the Peon already refuted; it is not evidence of live work.
    if (refutedRunRef.current.has(sessionKey)) return;
    refreshMetadataForObservedRun();
    unconfirmedRunRef.current.add(sessionKey);
    setActiveRun((previous) => ({
      sessionKey,
      running: true,
      model: previous.sessionKey === sessionKey ? previous.model : null,
      reasoningEffort: previous.sessionKey === sessionKey ? previous.reasoningEffort : null,
      assumedAt: previous.sessionKey === sessionKey ? previous.assumedAt : null,
    }));
  }, [refreshMetadataForObservedRun, sessionKey]);
  const onRunFinished = useCallback((event?: { type?: string; is_error?: boolean }) => {
    observedRunMetadataRefreshRef.current.delete(sessionKey);
    // Each completed turn may have changed project files, including a turn
    // followed immediately by queued work. Revalidate the open tree at this
    // boundary even when the overall session remains active.
    setFileRefreshRevision((value) => value + 1);
    if (queueActivityRef.current.hasPending(sessionKey)) return;
    setRunning(false);
    setMetaTick((value) => value + 1);
    markAttentionRead();
    if (!event || !isSuccessfulRunResult(event)) return;
    if (suppressCompletionSoundRef.current) {
      suppressCompletionSoundRef.current = false;
      return;
    }
    playPeonSound("complete");
  }, [markAttentionRead, sessionKey, setRunning]);
  const onWorkStarted = useCallback(() => {
    suppressCompletionSoundRef.current = false;
    playPeonSound("start");
  }, []);
  const onAgentUpdate = useCallback(() => playWorkSound(), []);
  const onQueueChange = useCallback(() => {
    return queueReconcilerRef.current?.reconcile() ?? Promise.resolve();
  }, []);
  const onTransportGap = useCallback(() => {
    void queueReconcilerRef.current?.reconcile();
    void refreshPluginInquiries();
  }, [refreshPluginInquiries]);
  const onPreview = useCallback((target: PreviewTarget) => {
    setArtifactPreview(target);
  }, []);
  const {
    history,
    live,
    orderedLive,
    showHistorySpinner,
    historyLoadError,
    hasOlder,
    loadingOlder,
    olderLoadError,
    loadOlder,
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
    onRunningChange: onLiveRunningChange,
    onSnapshotRunning,
    onRunFinished,
    onAgentUpdate,
    onQueueChange,
    onTransportGap,
    onPreview,
  });

  // The transcript follows new output while the operator is standing at the
  // bottom of it, and never otherwise. Every scroll — theirs or Virtuoso's own
  // — answers that outright, so there is nothing here to time out, suppress or
  // guess at while a slow turn appends rows. See transcriptFollow.ts.
  const [followOutput, setFollowOutput] = useState(true);
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const virtuosoScrollerRef = useRef<HTMLElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const handleScroll = useCallback(() => {
    const scroller = virtuosoScrollerRef.current;
    if (!scroller) return;
    setFollowOutput(transcriptFollowsOutput(scroller));
    setShowScrollToBottom(transcriptShowsJumpToNewest(scroller));
  }, []);
  const handleScrollerRef = useCallback((ref: HTMLElement | Window | null) => {
    const previous = virtuosoScrollerRef.current;
    if (previous) previous.removeEventListener("scroll", handleScroll);
    const scroller = ref instanceof HTMLElement ? ref : null;
    virtuosoScrollerRef.current = scroller;
    if (scroller) scroller.addEventListener("scroll", handleScroll, { passive: true });
  }, [handleScroll]);
  const handleStartReached = useCallback(() => {
    // useSessionTranscript owns the synchronous single-flight guard. If a
    // short page still leaves the viewport at the top, Virtuoso may request
    // the following cursor after it settles; that is pagination, not a
    // duplicate request.
    if (hasOlder) void loadOlder();
  }, [hasOlder, loadOlder]);
  const handleGhostCreated = useCallback(() => {
    // The operator sent this one, so the transcript goes back to following it
    // even if they were reading history when they pressed Send.
    setFollowOutput(true);
    setShowScrollToBottom(false);
  }, []);

  const closeReplyContextMenu = useCallback(() => setReplyContextMenu(null), []);
  const handleReplyContextMenu = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!selectedTextRepliesSupported || window.matchMedia?.("(pointer: coarse)").matches) return;
    const row = event.currentTarget;
    const selection = window.getSelection();
    const selected = selectedTextReplyForRow(row, row.dataset.replyableEventId, selection);
    if (!selected || !selection) return;
    event.preventDefault();
    const range = selection.rangeCount > 0 ? selection.getRangeAt(0).getBoundingClientRect() : null;
    const target = event.target instanceof Element
      ? event.target
      : event.target instanceof Node
        ? event.target.parentElement
        : null;
    const linkHref = target?.closest<HTMLAnchorElement>("a")?.href ?? null;
    setReplyContextMenu({
      replyTo: selected,
      row,
      selection: captureSelectionSnapshot(selection),
      x: event.clientX || range?.right || 8,
      y: event.clientY || range?.bottom || 8,
      linkHref,
    });
  }, [selectedTextRepliesSupported]);

  useEffect(() => {
    setReplyContextMenu(null);
  }, [selectedTextRepliesSupported, sessionKey]);

  const activateReplyFromContextMenu = useCallback((selected: SelectedTextReply) => {
    setReplyContextMenu(null);
    setReplyTo(selected);
    window.getSelection()?.removeAllRanges();
  }, []);

  const openReplySource = useCallback((selected: SelectedTextReply) => {
    const rows = document.querySelectorAll<HTMLElement>("[data-replyable-event-id]");
    const source = [...rows].find((row) => row.dataset.replyableEventId === selected.eventId);
    source?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, []);

  const visibleEvents = useMemo(
    () => combineVisibleTranscriptEvents(history ?? [], orderedLive),
    [history, orderedLive],
  );
  const committedCommandIds = useMemo(() => new Set(visibleEvents.flatMap((event) => typeof event.commandId === "string" ? [event.commandId] : [])), [visibleEvents]);
  useEffect(() => {
    if (!contextMessagesSupported || mentionAttentionIds.size === 0 || document.visibilityState !== "visible") return;
    const rendered = visibleEvents.flatMap((event) => typeof event.eventId === "string" && mentionAttentionIds.has(event.eventId) ? [event.eventId] : []);
    if (rendered.length === 0) return;
    void api(`${base}/sessions/${encodeURIComponent(sid)}/mention-attention/read`, { method: "POST", body: JSON.stringify({ eventIds: rendered.slice(0, 100) }) }).then(() => {
      setMentionAttentionIds((current) => new Set([...current].filter((id) => !rendered.includes(id))));
    }).catch(() => undefined);
  }, [base, contextMessagesSupported, mentionAttentionIds, sid, visibleEvents]);
  // The composer's ghost retires as soon as this grows past what it captured.
  const userMessageCount = useMemo(
    () => visibleEvents.reduce((count, event) => count + (event.type === "user_message" ? 1 : 0), 0),
    [visibleEvents],
  );
  const {
    input, setInput, files, setFiles, carried, setCarried, sending, sendError, setSendError, ghost,
    queueItems, removingQueueItems, steeringQueueItems, filesEnabled, send, sendContext, enqueue, removeQueuedItem, editQueuedItem, steerQueuedItem,
  } = useSessionComposer({
    base,
    sid,
    sessionKey,
    wsId,
    peonId: peon.peonId,
    t,
    running,
    runningModel,
    runningReasoningEffort,
    sessionModel,
    sessionReasoningEffort,
    sessionPermissionMode,
    sessionProvider,
    overrideModel,
    overrideReasoningEffort,
    catalog,
    currentSessionKeyRef,
    queueReconcilerRef,
    queueActivity: queueActivityRef.current,
    controlReadScope,
    userMessageCount,
    replyTo,
    setReplyTo,
    onGhostCreated: handleGhostCreated,
    setRunning,
    setRunningSelection,
    setStopNote,
    onWorkStarted,
    onSelectionAccepted,
    onQueuedSelectionRestored,
    mentions,
    setMentions,
    committedCommandIds,
  });
  const mentionQuery = contextMessagesSupported ? activeMentionQuery(input, composerCaret ?? input.length) : null;
  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return [];
    const query = mentionQuery.query.toLowerCase();
    return mentionPrincipals.filter((principal) => principal.label.toLowerCase().includes(query)).slice(0, 8);
  }, [mentionPrincipals, mentionQuery]);
  const changeComposerInput = useCallback((value: string, caret?: number) => {
    setComposerCaret(caret ?? null);
    setInput(value);
    setMentions((current) => remapMentions(input, value, current));
  }, [input, setInput]);
  const selectMention = useCallback((principal: MentionPrincipal) => {
    const query = activeMentionQuery(input, composerCaret ?? input.length);
    if (!query) return;
    const selected = insertMention(input, query, principal, mentions);
    const caret = query.startUtf16 + principal.label.length + 2;
    setInput(selected.text);
    setMentions(selected.mentions);
    setComposerCaret(caret);
    setCaretRequest({ position: caret, seq: caretSeqRef.current++ });
  }, [composerCaret, input, mentions, setInput]);
  const removeSelectedMention = useCallback((mention: ComposerMention) => {
    const removed = removeMention(input, mentions, mention);
    setInput(removed.text);
    setMentions(removed.mentions);
    setComposerCaret(mention.startUtf16);
    setCaretRequest({ position: mention.startUtf16, seq: caretSeqRef.current++ });
  }, [input, mentions, setInput]);


  useEffect(() => {
    let alive = true;
    const runRevision = runRevisionRef.current.get(sessionKey) ?? 0;
    api<{ title?: string | null; prompt?: string | null; promptPreview?: string | null; projectKey?: string | null; projectId?: string | null; projectRoot?: string | null; status?: string | null; agent?: string | null; backendSessionId?: string | null; model?: string | null; reasoningEffort?: string | null; permissionMode?: string | null; turnCount?: number | null; usage?: unknown; branchedFromSessionId?: string | null; parentSessionId?: string | null }>(
      `${base}/sessions/${encodeURIComponent(sid)}`,
    )
      .then((s) => {
        if (!alive) return;
        metadataStatusRef.current.set(sessionKey, s.status ?? null);
        setTitle(s.title ?? null);
        setOpeningMessage(s.promptPreview?.trim() || s.prompt?.trim() || null);
        setDraft(s.title ?? "");
        setEditing(false);
        setProjectKey(s.projectKey ?? null);
        setProjectId(s.projectId ?? null);
        setProjectRoot(s.projectRoot ?? null);
        setTurnCount(typeof s.turnCount === "number" ? s.turnCount : null);
        setSessionUsage(s.usage ?? null);
        const source = sessionLineage(s);
        setLineage(source ? { ...source, title: null } : null);
        setSessionAgent(s.agent ?? null);
        setSessionReasoningEffort(s.reasoningEffort ?? null);
        setSessionPermissionMode(s.permissionMode ?? null);
        // Do not let a metadata request that started before a local/live run
        // transition overwrite that newer transition when its response arrives.
        if ((runRevisionRef.current.get(sessionKey) ?? 0) === runRevision) {
          const peonRunning = s.status === "running";
          // A record still claiming a run the Peon itself refused stays refused.
          if (!peonRunning || !refutedRunRef.current.has(sessionKey)) setRunning(peonRunning);
          if (peonRunning) setRunningSelection(s.model ?? null, s.reasoningEffort ?? null);
        }
        setSessionModel(s.model ?? null);
        setLoadedMetadataKey(sessionKey);
      })
      .catch(() => {
        if (!alive) return;
        // The record could not be read at all — a Peon this Overseer can no
        // longer reach over HTTP answers nothing here. Silence is not evidence
        // of live work, so withdraw a run only the transcript implied instead of
        // leaving an indicator and a Stop button that can never succeed. Record
        // the absent status too, so a snapshot landing later stays quiet.
        metadataStatusRef.current.set(sessionKey, null);
        if ((runRevisionRef.current.get(sessionKey) ?? 0) !== runRevision) return;
        if (unconfirmedRunRef.current.has(sessionKey)) {
          setRunning(false);
        } else {
          // An indexed cache seed is useful only while its direct confirmation
          // is pending. A stated transport failure retires it before the TTL.
          setActiveRun((current) => current.sessionKey === sessionKey && current.assumedAt !== null
            ? { ...current, running: false, model: null, reasoningEffort: null, assumedAt: null }
            : current);
        }
      });
    return () => {
      alive = false;
    };
  }, [base, sid, sessionKey, metaTick, setRunning, setRunningSelection]);

  useEffect(() => {
    if (!lineage?.sourceSessionId || lineage.title !== null) return;
    let alive = true;
    api<{ title?: string | null; promptPreview?: string | null; prompt?: string | null }>(`${base}/sessions/${encodeURIComponent(lineage.sourceSessionId)}`)
      .then((source) => {
        if (!alive) return;
        setLineage((current) => current?.sourceSessionId === lineage.sourceSessionId
          ? { ...current, title: source.title?.trim() || source.promptPreview?.trim() || source.prompt?.trim() || lineage.sourceSessionId }
          : current);
      })
      .catch(() => {
        if (alive) setLineage((current) => current?.sourceSessionId === lineage.sourceSessionId ? { ...current, title: lineage.sourceSessionId } : current);
      });
    return () => { alive = false; };
  }, [base, lineage]);

  async function remove() {
    setDeleting(true);
    setDeleteNote(null);
    const nextSessionId = nextSessionAfterDeletion(orderedSessionIds, sid);
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
      refreshSessionPins();
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
      const outcome = stopOutcome(err);
      // 409 ⇒ the run had already ended and this page still showed it live.
      // Clear the stale indicator and refetch the peon's authoritative record
      // instead of leaving a stop button that can only ever fail again.
      if (outcome === "already-stopped") {
        refutedRunRef.current.add(sessionKey);
        setRunning(false);
        setMetaTick((value) => value + 1);
      }
      setStopNote(outcome === "already-stopped" ? t("session.stop.nothing") : outcome === "unsupported" ? t("peon.unsupported") : t("error.generic"));
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

  // What the agent is doing right now, from the freshest event (live wins over history).
  const lastEvent = visibleEvents.length ? visibleEvents[visibleEvents.length - 1] : undefined;
  const continuationFailure = sessionContinuationFailure(lastEvent);
  const unexecutedPrompt = useMemo(() => continuationFailure ? lastUnexecutedUserPrompt(visibleEvents) : null, [continuationFailure, visibleEvents]);
  const working = workingActivity(lastEvent);
  const workingStepKey = lastEvent
    ? String(lastEvent.eventId ?? lastEvent._tailEventId ?? lastEvent._tailId ?? `${lastEvent.type ?? "event"}:${lastEvent.createdAt ?? "unstamped"}:${history?.length ?? 0}:${orderedLive.length}`)
    : `${sessionKey}:starting`;
  // Flattened render list — pairs each tool_use with its later tool_result so it
  // renders as a single row (see flattenEvents).
  const items = useMemo(() => flattenEvents(visibleEvents, t), [t, visibleEvents]);
  const yesterdayLabelText = t("peon.stats.period.yesterday");
  // Keep callbacks stable so virtual transcript rows do not receive needless
  // prop changes on unrelated page state updates.
  const onOpenPreviewItem = useCallback(
    (p: { path: string; author?: string; createdAt?: number }) => setArtifactPreview({ path: p.path, author: p.author, createdAt: p.createdAt }),
    [],
  );
  const onOpenProjectFileItem = useCallback(
    (path: string, viewerUrl: string) => setProjectFilePreview({ path, viewerUrl }),
    [],
  );
  const projectViewer = useMemo(
    () => (loadedMetadataKey === sessionKey && projectId && projectRoot
      ? { peonId: peon.peonId, projectId, projectRoot, currentOrigin: window.location.origin }
      : null),
    [loadedMetadataKey, sessionKey, projectId, projectRoot, peon.peonId],
  );
  // An agent row lands without an entrance animation: the operator is reading a
  // stream they did not just author, and a rerun of motion on every pushed row
  // pulls the eye away from the text. Only a message the operator sent animates,
  // and that animation belongs to the composer's ghost.
  const transcriptTurns = useMemo(
    () => visibleEvents.reduce((sum, ev) => sum + (ev.type === "result" && typeof ev.num_turns === "number" ? ev.num_turns : 0), 0),
    [visibleEvents],
  );
  const turnTotal = turnCount ?? transcriptTurns;
  const lastAssistantItemKey = useMemo(() => {
    for (let index = items.length - 1; index >= 0; index--) {
      if (items[index]?.kind === "text") return items[index]!.key;
    }
    return null;
  }, [items]);
  const usageSummary = useMemo(() => {
    const fromSession = usageBreakdown(sessionUsage);
    if (fromSession) return fromSession;
    // No structured total yet (session still running, or peon hasn't reported
    // one) — each turn's own usage already reflects the whole context resent up
    // to that point, so summing across turns would multiply-count it. The
    // freshest turn's usage is the best available snapshot.
    for (let i = visibleEvents.length - 1; i >= 0; i--) {
      const u = usageFromEvent(visibleEvents[i]);
      if (u) return u;
    }
    return null;
  }, [sessionUsage, visibleEvents]);
  const virtualRows = useMemo<VirtualTranscriptRow[]>(() => {
    const rows: VirtualTranscriptRow[] = items.map((item, index) => ({
      key: `item:${item.key}`,
      kind: "item",
      item,
      paddingClass: index === 0 ? "" : gapPaddingClass(
        items[index - 1]!.kind === "user",
        item.kind === "user",
        items[index - 1]!.kind === "text" || item.kind === "text",
      ),
    }));
    if (continuationFailure) rows.push({ key: "session-continuation-recovery", kind: "recovery", failure: continuationFailure, paddingClass: "pt-6" });
    if (ghost) {
      rows.push({
        key: "session-ghost",
        kind: "ghost",
        ghost,
        paddingClass: items.length === 0 ? "" : gapPaddingClass(items[items.length - 1]!.kind === "user", true),
      });
    }
    let insertedInquiries = 0;
    for (const inquiry of [...pluginInquiries.inquiries].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const itemIndex = inquiryInsertionIndex(items, inquiry.createdAt);
      rows.splice(itemIndex + insertedInquiries, 0, { key: `plugin-inquiry:${inquiry.inquiryId}`, kind: "inquiry", inquiry, paddingClass: "pt-6" });
      insertedInquiries += 1;
    }
    if (lineage) rows.unshift({ key: "session-lineage", kind: "lineage", ...lineage, paddingClass: "pb-6" });
    if (liveWork) {
      const previousIsUser = ghost || (items.length > 0 && items[items.length - 1]!.kind === "user");
      rows.push({
        key: "session-working",
        kind: "working",
        // The working indicator reads as assistant prose, not another compact
        // row, so it keeps the same breathing room a text row gets after one.
        paddingClass: items.length === 0 && !ghost ? "" : gapPaddingClass(Boolean(previousIsUser), false, true),
      });
    }
    rows.push({ key: "session-footer", kind: "footer", height: composerHeight + 40 });
    return rows;
  }, [composerHeight, continuationFailure, ghost, items, lineage, liveWork, pluginInquiries.inquiries]);
  const recoverInNewSession = useCallback(async () => {
    if (recovering) return;
    setRecovering(true);
    setRecoveryError(null);
    try {
      const created = await createContinuationSession(base, {
        sourceSessionId: sid, sourceUrl: window.location.href, prompt: unexecutedPrompt,
        projectKey, dir: projectRoot, agent: sessionAgent, model: sessionModel, reasoningEffort: sessionReasoningEffort,
      });
      navigate(sessionHref?.(peon.peonId, created.id) ?? `/peons/${encodeURIComponent(peon.peonId)}/sessions/${encodeURIComponent(created.id)}`);
    } catch (error) {
      setRecoveryError(error instanceof ApiError ? error.message : t("session.recovery.failed"));
      setRecovering(false);
    }
  }, [base, navigate, peon.peonId, projectKey, projectRoot, recovering, sessionAgent, sessionHref, sessionModel, sessionReasoningEffort, sid, t, unexecutedPrompt]);
  const [virtualWindow, setVirtualWindow] = useState(() => createTranscriptVirtualWindow(sessionKey, virtualRows));
  let displayedVirtualWindow = virtualWindow;
  if (virtualWindow.sessionKey !== sessionKey || virtualWindow.rows !== virtualRows) {
    displayedVirtualWindow = updateTranscriptVirtualWindow(virtualWindow, sessionKey, virtualRows);
    setVirtualWindow(displayedVirtualWindow);
  }
  const scrollToBottom = useCallback(() => {
    setFollowOutput(true);
    setShowScrollToBottom(false);
    const lastIndex = displayedVirtualWindow.firstItemIndex + displayedVirtualWindow.rows.length - 1;
    virtuosoRef.current?.scrollToIndex({ index: lastIndex, align: "end", behavior: "auto" });
  }, [displayedVirtualWindow]);
  // The ghost row exists in this render's rows, but Virtuoso has not measured
  // it yet. Land on it once, after two frames; everything the agent appends
  // afterwards is followOutput's business.
  const scrolledGhostRef = useRef<ComposerGhost | null>(null);
  useEffect(() => {
    if (!ghost) {
      scrolledGhostRef.current = null;
      return;
    }
    if (scrolledGhostRef.current === ghost) return;
    scrolledGhostRef.current = ghost;
    const lastIndex = displayedVirtualWindow.firstItemIndex + displayedVirtualWindow.rows.length - 1;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({ index: lastIndex, align: "end", behavior: "auto" });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [displayedVirtualWindow.firstItemIndex, displayedVirtualWindow.rows.length, ghost]);
  useEffect(() => {
    // A freshly opened session starts at its newest row, which is the bottom.
    setFollowOutput(true);
    setShowScrollToBottom(false);
  }, [sessionKey]);
  useEffect(() => () => {
    const scroller = virtuosoScrollerRef.current;
    if (scroller) scroller.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);
  const cancelRename = () => {
    setDraft(title ?? "");
    setRenameNote(null);
    setEditing(false);
  };
  // The metadata prompt is the opening message of the whole conversation. Do
  // not derive header identity from the currently loaded transcript page: for
  // long sessions that page is only a recent batch and can start mid-thread.
  const headerIdentity = sessionHeaderIdentityData(
    loadedMetadataKey,
    sessionKey,
    title,
    openingMessage,
    projectKey,
    selectedSession,
  );

  return (
    <div className="session-transcript-pane fixed bottom-0 left-0 right-0 top-12 z-10 min-w-0 overflow-hidden md:left-[var(--peon-sidebar-width)] md:top-[var(--fixed-pane-header-height,3.25rem)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 z-20">
        <SessionHeader
          peonId={peon.peonId}
          metadataLoading={headerIdentity.metadataLoading}
          projectKey={headerIdentity.projectKey}
          title={headerIdentity.title}
          draft={loadedMetadataKey === sessionKey ? draft : headerIdentity.draft}
          setDraft={setDraft}
          editing={editing}
          setEditing={setEditing}
          savingName={savingName}
          renameNote={renameNote}
          setRenameNote={setRenameNote}
          openingMessage={headerIdentity.openingMessage}
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
          onShare={() => setSharingOpen(true)}
        />
      </div>
      <div
        className="pointer-events-none absolute left-0 right-0 top-2 z-20 grid h-8 place-items-center"
        aria-live="polite"
      >
        {(historyLoadError || loadingOlder || olderLoadError) && (
          <p className={`whitespace-nowrap rounded-full border border-white/10 bg-surface/75 px-3 py-1.5 font-mono text-xs shadow-lg shadow-black/30 backdrop-blur-xl ${historyLoadError || olderLoadError ? "text-red-300" : "text-ink-muted"}`}>
            {historyLoadError
              ? t("session.history.latestFailed")
              : olderLoadError ? t("session.history.failed") : t("session.history.loading")}
          </p>
        )}
      </div>
      <div className="h-full min-w-0 overflow-hidden">
        {history === null ? (
          showHistorySpinner && (
            <div className="grid h-full place-items-center pt-12">
              <div className="loading-spinner" />
            </div>
          )
        ) : history.length === 0 && live.length === 0 && !liveWork && !pluginInquiries.loading && pluginInquiries.inquiries.length === 0 ? (
          <p className="grid h-full place-items-center pt-12 text-center font-mono text-sm text-ink-faint">{t("session.empty")}</p>
        ) : (
          <Virtuoso
            key={sessionKey}
            ref={virtuosoRef}
            scrollerRef={handleScrollerRef}
            className="h-full overflow-x-hidden"
            data={displayedVirtualWindow.rows}
            firstItemIndex={displayedVirtualWindow.firstItemIndex}
            initialTopMostItemIndex={displayedVirtualWindow.rows.length - 1}
            alignToBottom
            increaseViewportBy={{ top: 600, bottom: 400 }}
            components={{ Header: TranscriptListHeader }}
            computeItemKey={(_index, row) => row.key}
            startReached={handleStartReached}
            followOutput={transcriptFollowOutput(followOutput)}
            itemContent={(_index, row) => {
              if (row.kind === "footer") return <div style={{ height: row.height }} aria-hidden="true" />;
              if (row.kind === "lineage") return (
                <div data-session-lineage className={`mx-auto w-full max-w-6xl px-3 sm:px-6 ${row.paddingClass}`}>
                  <div className="flex items-center gap-2 rounded-lg border border-edge/80 bg-surface-raised/50 px-3 py-2 font-body text-xs text-ink-muted">
                    <GitFork size={14} className="flex-none text-accent-strong" aria-hidden />
                    <span>{t(row.relation === "branch" ? "session.lineage.branched" : "session.lineage.subsession")}</span>
                    <button type="button" className="min-w-0 truncate text-accent-strong underline decoration-dotted underline-offset-2 hover:text-ink" onClick={() => navigate(sessionHref?.(peon.peonId, row.sourceSessionId) ?? `/peons/${encodeURIComponent(peon.peonId)}/sessions/${encodeURIComponent(row.sourceSessionId)}`)}>
                      {row.title ?? t("session.lineage.loading")}
                    </button>
                  </div>
                </div>
              );
              if (row.kind === "item") {
                const replyableEventId = row.item.kind === "user" || row.item.kind === "text" ? row.item.sourceEventId : undefined;
                return (
                  <div data-transcript-row data-replyable-event-id={replyableEventId} onContextMenu={replyableEventId ? handleReplyContextMenu : undefined} className={`mx-auto w-full max-w-6xl px-3 sm:px-6 ${row.paddingClass}`}>
                    <ItemView
                      item={row.item}
                      t={t}
                      locale={locale}
                      yesterdayLabel={yesterdayLabelText}
                      simpleTools={simpleTools}
                      onOpenPreview={onOpenPreviewItem}
                      onOpenAttachment={setSentAttachmentPreview}
                      onOpenReplySource={openReplySource}
                      onOpenProjectFile={onOpenProjectFileItem}
                      projectViewer={projectViewer}
                    />
                    {isOwner && peon.online && sessionProvider?.agent === "claude-code" && sessionProvider.capabilities?.login && ((row.item.kind === "notice" && row.item.tone === "error" && signedOut(row.item.text)) || (row.item.kind === "text" && Boolean(row.item.providerError) && signedOut(`${row.item.providerError} ${row.item.text}`))) && <ProviderLogin key={`${base}/${sid}/${row.item.key}`} base={base} provider="claude-code" />}
                    {row.item.key === lastAssistantItemKey && (
                      <BranchMessageMenu branching={branching} disabled={liveWork} error={branchError} onBranch={() => void branchSession()} t={t} />
                    )}
                  </div>
                );
              }
              if (row.kind === "ghost") return (
                <div data-session-ghost-row className={`session-ghost mx-auto w-full max-w-6xl px-3 sm:px-6 ${row.paddingClass}`}>
                  <UserBubble
                    text={row.ghost.text}
                    authorEmail={user?.email}
                    authorGithubLogin={user?.githubLogin ?? undefined}
                    authorAvatarUrl={user?.avatarUrl ?? undefined}
                    attachments={row.ghost.attachments}
                    replyTo={row.ghost.replyTo ?? undefined}
                    createdAt={row.ghost.createdAt}
                  />
                </div>
              );
              if (row.kind === "inquiry") return (
                <div data-plugin-inquiry-row className={`mx-auto w-full max-w-6xl px-3 sm:px-6 ${row.paddingClass}`}>
                  <PluginInquiryCard
                    inquiry={row.inquiry}
                    onInstall={() => void pluginInquiries.respond(row.inquiry, "install")}
                    onCancel={() => void pluginInquiries.respond(row.inquiry, "cancel")}
                  />
                </div>
              );
              if (row.kind === "recovery") return (
                <div data-session-recovery className={`mx-auto w-full max-w-6xl px-3 sm:px-6 ${row.paddingClass}`}>
                  <div role="alert" className="rounded-xl border border-danger/35 bg-danger/5 px-4 py-3 font-body text-sm text-ink">
                    <p className="font-medium">{t("session.recovery.title")}</p>
                    <p className="mt-1 text-ink-muted">{t(row.failure === "missing_history" ? "session.recovery.missingHistory" : "session.recovery.timeout")}</p>
                    <p className="mt-1 text-xs text-ink-faint">{t("session.recovery.notExecuted")}</p>
                    <button type="button" disabled={recovering} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-accent-strong px-3 py-2 text-xs font-medium text-white disabled:opacity-50" onClick={() => void recoverInNewSession()}>
                      {recovering ? <LoaderCircle size={14} className="animate-spin" aria-hidden /> : <ArrowRight size={14} aria-hidden />}
                      {recovering ? t("session.recovery.creating") : t("session.recovery.action")}
                    </button>
                    {recoveryError && <p className="mt-2 text-xs text-danger">{recoveryError}</p>}
                  </div>
                </div>
              );
              return (
                <div data-session-running-row className={`mx-auto w-full max-w-6xl px-3 sm:px-6 ${row.paddingClass}`}>
                  <Working
                    key={workingStepKey}
                    label={
                      working.key === "session.working.thinking"
                        ? null
                        : t(working.key, working.name ? { name: working.name } : undefined)
                    }
                    startedAt={typeof lastEvent?.createdAt === "number" ? lastEvent.createdAt : undefined}
                    model={modelLabel(catalog, runningModel ?? sessionModel ?? defaultModelId(sessionProvider))}
                    effort={reasoningEffortLabel(sessionProvider, runningReasoningEffort ?? sessionReasoningEffort, runningModel ?? sessionModel ?? defaultModelId(sessionProvider))}
                    onStop={stop}
                    stopping={stopping}
                    stopLabel={t("session.stop")}
                    stoppingLabel={t("session.stop.stopping")}
                  />
                </div>
              );
            }}
          />
        )}
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
              className="pointer-events-auto grid size-10 place-items-center rounded-full border border-edge-strong bg-surface/95 text-ink shadow-lg backdrop-blur transition-colors hover:border-warning-strong/60 hover:bg-surface-raised hover:text-warning-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning-strong/70"
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
        steeringQueueItems={steeringQueueItems}
        removeQueuedItem={removeQueuedItem}
        editQueuedItem={editQueuedItem}
        steerQueuedItem={steerQueuedItem}
        input={input}
        setInput={changeComposerInput}
        running={running}
        enqueue={enqueue}
        send={send}
        sendContext={sendContext}
        sending={sending}
        controlConnected={peon.controlConnected ?? peon.online}
        files={files}
        setFiles={setFiles}
        carried={carried}
        setCarried={setCarried}
        setAttachmentPreview={setAttachmentPreview}
        filesEnabled={filesEnabled}
        sendError={sendError}
        setSendError={setSendError}
        replyTo={replyTo}
        setReplyTo={setReplyTo}
        onOpenReplySource={openReplySource}
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
        sendToPeople={contextMessagesSupported && mentionsRouteToPeople(mentions)}
        mentionSuggestions={mentionSuggestions}
        onSelectMention={selectMention}
        mentionMenuOpen={mentionQuery !== null}
        selectedMentions={mentions}
        onRemoveMention={removeSelectedMention}
        caretRequest={caretRequest}
      />
      {replyContextMenu && (
        <SelectedTextReplyContextMenu
          replyTo={replyContextMenu.replyTo}
          row={replyContextMenu.row}
          selection={replyContextMenu.selection}
          x={replyContextMenu.x}
          y={replyContextMenu.y}
          linkHref={replyContextMenu.linkHref}
          onReply={activateReplyFromContextMenu}
          onClose={closeReplyContextMenu}
        />
      )}
      <SessionOverlays
        peonId={peon.peonId}
        base={base}
        sid={sid}
        // The identity the header already shows: the indexed row names the
        // session's project, so the tree opens on it instead of waiting for the
        // record and asserting meanwhile that there is no project at all.
        projectKey={headerIdentity.projectKey}
        projectKeyKnown={loadedMetadataKey === sessionKey || Boolean(selectedSession)}
        filesOpen={filesOpen}
        fileRefreshRevision={fileRefreshRevision}
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
      <SessionSharingPanel
        base={base}
        sessionId={sid}
        open={sharingOpen}
        onClose={() => setSharingOpen(false)}
      />
    </div>
  );
}
