import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { api } from "../../../api";
import type { TailFrame } from "../../../liveSocket";
import { isAgentWorkUpdate } from "../../../peonSounds";
import { latestRunSignal, runSignalFromEvent, sig, type Ev } from "./parsing";
import {
  canLiveCommitPending,
  numericTailId,
  orderLiveEvents,
  reconcileAuthoritativeSnapshot,
  reconcileDurableSnapshot,
  type PendingEcho,
} from "./transcriptMerge";
import type { PreviewTarget } from "./PreviewPanel";
import {
  eventId,
  mergeNewestPage,
  pagesOverlap,
  parseTranscriptPage,
  prependOlderPage,
  transcriptPageUrl,
  type LoadedTranscript,
  type TranscriptPage,
  type TranscriptResponse,
} from "./transcriptPagination";
import {
  TAIL_FALLBACK_CHECK_MS,
  replaceTranscriptRequest,
  transcriptReconcileMode,
} from "./transcriptReconciliation";

interface Args {
  base: string;
  sid: string;
  sessionKey: string;
  peonId: string;
  paginationSupported: boolean;
  running: boolean;
  subscribe: (peonId: string, sessionId: string, onFrame: (frame: TailFrame) => void, lastEventId?: string | null) => () => void;
  metadataStatusRef: MutableRefObject<Map<string, string | null>>;
  previewPinnedRef: MutableRefObject<boolean>;
  onRunningChange: (running: boolean) => void;
  onSnapshotRunning: () => void;
  onRunFinished: (event?: Ev) => void;
  onAgentUpdate: (event: Ev) => void;
  onQueueChange: () => void;
  onPreview: (target: PreviewTarget) => void;
}

export function useSessionTranscript({
  base,
  sid,
  sessionKey,
  peonId,
  paginationSupported,
  running,
  subscribe,
  metadataStatusRef,
  previewPinnedRef,
  onRunningChange,
  onSnapshotRunning,
  onRunFinished,
  onAgentUpdate,
  onQueueChange,
  onPreview,
}: Args) {
  const [history, setHistory] = useState<Ev[] | null>(null);
  const [live, setLive] = useState<Ev[]>([]);
  const [showHistorySpinner, setShowHistorySpinner] = useState(false);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderLoadError, setOlderLoadError] = useState(false);
  // undefined means the initial snapshot is not ready yet; null means it has no
  // durable boundary. Waiting closes the fetch→tail race without replaying history.
  const [tailStartId, setTailStartId] = useState<string | null | undefined>(undefined);
  const pendingEchoesRef = useRef<PendingEcho[]>([]);
  const historyReadyRef = useRef(false);
  const historyLengthRef = useRef(0);
  const loadedTranscriptRef = useRef<LoadedTranscript | null>(null);
  const historyEventIdsRef = useRef<Set<string>>(new Set());
  const tailHighWaterRef = useRef(0);
  const seenTailIdsRef = useRef<Set<number>>(new Set());
  const seenTailEventIdsRef = useRef<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());
  const pendingLiveRef = useRef<Array<{ event: Ev; tailId: number | null; tailEventId: string | null }>>([]);
  const olderLoadInFlightRef = useRef(false);
  const reconciliationSessionRef = useRef(sessionKey);
  const lastTailActivityAtRef = useRef<number | null>(Date.now());
  const tailUnhealthyRef = useRef(false);
  const lastFallbackReconcileAtRef = useRef<number | null>(null);
  const latestReconcileControllerRef = useRef<AbortController | null>(null);
  const olderLoadControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setShowHistorySpinner(false);
    const id = window.setTimeout(() => setShowHistorySpinner(true), 1000);
    return () => window.clearTimeout(id);
  }, [sid]);

  if (reconciliationSessionRef.current !== sessionKey) {
    // Effects run after paint. Reset synchronously so an immediate submit on a
    // new route cannot inherit the previous session's tail position or echoes.
    reconciliationSessionRef.current = sessionKey;
    historyReadyRef.current = false;
    historyLengthRef.current = 0;
    loadedTranscriptRef.current = null;
    historyEventIdsRef.current = new Set();
    tailHighWaterRef.current = 0;
    seenTailIdsRef.current = new Set();
    seenTailEventIdsRef.current = new Set();
    seenRef.current = new Set();
    pendingLiveRef.current = [];
    pendingEchoesRef.current = [];
    lastTailActivityAtRef.current = Date.now();
    tailUnhealthyRef.current = false;
    lastFallbackReconcileAtRef.current = null;
    latestReconcileControllerRef.current?.abort();
    latestReconcileControllerRef.current = null;
    olderLoadControllerRef.current?.abort();
    olderLoadControllerRef.current = null;
  }

  const consumeOptimisticEcho = useCallback((event: Ev, tailId: number | null, tailEventId: string | null): boolean => {
    const index = pendingEchoesRef.current.findIndex((pending) => canLiveCommitPending(event, pending, tailId, tailEventId));
    if (index < 0) return false;
    const pending = pendingEchoesRef.current[index]!;
    pendingEchoesRef.current.splice(index, 1);
    if (tailId !== null) seenTailIdsRef.current.add(tailId);
    if (tailEventId !== null) seenTailEventIdsRef.current.add(tailEventId);
    setLive((previous) => previous.map((current) => current._clientId === pending.clientId ? {
      ...event,
      author: event.authorEmail ?? current.authorEmail ?? event.author ?? current.author,
      authorEmail: event.authorEmail ?? current.authorEmail,
      authorGithubLogin: event.authorGithubLogin ?? current.authorGithubLogin,
      authorAvatarUrl: event.authorAvatarUrl ?? current.authorAvatarUrl,
      commandId: event.commandId ?? current.commandId,
      createdAt: typeof event.createdAt === "number" ? event.createdAt : current.createdAt,
      attachments: event.attachments ?? current.attachments,
      _tailId: tailId ?? undefined,
      _tailEventId: tailEventId ?? undefined,
      _clientId: pending.clientId,
      _optimistic: true,
      _baselineTailId: pending.baselineTailId,
    } : current));
    return true;
  }, []);

  const pushLive = useCallback((event: Ev, tailId: number | null, tailEventId: string | null): boolean => {
    if (tailEventId !== null) {
      if (historyEventIdsRef.current.has(tailEventId) || seenTailEventIdsRef.current.has(tailEventId)) return false;
      seenTailEventIdsRef.current.add(tailEventId);
      setLive((previous) => [...previous, {
        ...event,
        _tailEventId: tailEventId,
        createdAt: event.type === "user_message" && typeof event.createdAt !== "number" ? Date.now() : event.createdAt,
      }]);
      return true;
    }
    if (tailId !== null) {
      if (tailId <= historyLengthRef.current || seenTailIdsRef.current.has(tailId)) return false;
      seenTailIdsRef.current.add(tailId);
      setLive((previous) => [...previous, {
        ...event,
        _tailId: tailId,
        createdAt: event.type === "user_message" && typeof event.createdAt !== "number" ? Date.now() : event.createdAt,
      }]);
      return true;
    }
    const signature = sig(event);
    if (seenRef.current.has(signature)) return false;
    seenRef.current.add(signature);
    setLive((previous) => [...previous, event]);
    return true;
  }, []);

  const pushFreshEvent = useCallback((event: Ev, tailId: number | null = null, tailEventId: string | null = null): boolean => {
    if (consumeOptimisticEcho(event, tailId, tailEventId) || !pushLive(event, tailId, tailEventId)) return false;
    const signal = runSignalFromEvent(event);
    if (signal === "running") onRunningChange(true);
    else if (signal === "idle") onRunFinished(event);
    if (isAgentWorkUpdate(event)) onAgentUpdate(event);
    return true;
  }, [consumeOptimisticEcho, onAgentUpdate, onRunFinished, onRunningChange, pushLive]);

  const openFreshPreview = useCallback((event: Ev) => {
    if (event.type !== "preview" || typeof event.path !== "string" || !event.path || previewPinnedRef.current) return;
    onPreview({
      path: event.path,
      author: typeof event.author === "string" ? event.author : undefined,
      createdAt: typeof event.createdAt === "number" ? event.createdAt : undefined,
    });
  }, [onPreview, previewPinnedRef]);

  const applyAuthoritativeSnapshot = useCallback((page: TranscriptPage) => {
    if (!page.paginated && page.events.length < historyLengthRef.current) return;
    const pending = pendingEchoesRef.current;
    const match = page.paginated
      ? reconcileDurableSnapshot(page.events, [], pending)
      : reconcileAuthoritativeSnapshot(page.events, [], pending);
    pendingEchoesRef.current = match.pending;
    setLive((current) => (page.paginated
      ? reconcileDurableSnapshot(page.events, current, pending)
      : reconcileAuthoritativeSnapshot(page.events, current, pending)).live);
    const merged = mergeNewestPage(loadedTranscriptRef.current, page);
    loadedTranscriptRef.current = merged;
    historyLengthRef.current = merged.paginated ? 0 : merged.events.length;
    historyEventIdsRef.current = new Set(merged.events.flatMap((event) => eventId(event) ?? []));
    if (!merged.paginated) tailHighWaterRef.current = Math.max(tailHighWaterRef.current, merged.events.length);
    for (const event of page.events) seenRef.current.add(sig(event));
    setHasOlder(merged.paginated && merged.hasMore && merged.nextCursor !== null);
    setHistory(merged.events);
  }, []);

  const fetchLatestTranscript = useCallback(async (signal?: AbortSignal): Promise<TranscriptPage> => {
    let page = parseTranscriptPage(await api<TranscriptResponse>(
      transcriptPageUrl(base, sid, paginationSupported),
      signal ? { signal } : undefined,
    ));
    const current = loadedTranscriptRef.current;
    if (!page.paginated || !current?.paginated) return page;
    const knownIds = new Set(current.events.flatMap((event) => eventId(event) ?? []));
    const usedCursors = new Set<string>();
    while (knownIds.size && !pagesOverlap(page.events, knownIds) && page.hasMore && page.nextCursor) {
      const cursor = page.nextCursor;
      if (usedCursors.has(cursor)) throw new Error("Peon repeated a transcript cursor");
      usedCursors.add(cursor);
      const older = parseTranscriptPage(await api<TranscriptResponse>(
        transcriptPageUrl(base, sid, true, cursor),
        signal ? { signal } : undefined,
      ));
      if (!older.paginated) return older;
      page = prependOlderPage(page, older);
    }
    return page;
  }, [base, paginationSupported, sid]);

  useEffect(() => {
    let alive = true;
    historyReadyRef.current = false;
    historyLengthRef.current = 0;
    loadedTranscriptRef.current = null;
    historyEventIdsRef.current = new Set();
    tailHighWaterRef.current = 0;
    seenTailIdsRef.current = new Set();
    seenTailEventIdsRef.current = new Set();
    seenRef.current = new Set();
    pendingLiveRef.current = [];
    pendingEchoesRef.current = [];
    olderLoadInFlightRef.current = false;
    latestReconcileControllerRef.current?.abort();
    latestReconcileControllerRef.current = null;
    olderLoadControllerRef.current?.abort();
    olderLoadControllerRef.current = null;
    lastTailActivityAtRef.current = Date.now();
    tailUnhealthyRef.current = false;
    lastFallbackReconcileAtRef.current = null;
    setHistory(null);
    setLive([]);
    setHasOlder(false);
    setLoadingOlder(false);
    setOlderLoadError(false);
    setTailStartId(undefined);
    const ready = (page: TranscriptPage) => {
      applyAuthoritativeSnapshot(page);
      setTailStartId(page.paginated && page.events.length ? eventId(page.events[page.events.length - 1]!) : null);
      historyReadyRef.current = true;
      lastTailActivityAtRef.current = Date.now();
      tailUnhealthyRef.current = false;
      const metadataStatus = metadataStatusRef.current.get(sessionKey);
      if (latestRunSignal(page.events) === "running" && (metadataStatus === undefined || metadataStatus === "running")) onSnapshotRunning();
      const pending = pendingLiveRef.current;
      pendingLiveRef.current = [];
      for (const item of pending) {
        if (pushFreshEvent(item.event, item.tailId, item.tailEventId)) openFreshPreview(item.event);
      }
    };
    const controller = new AbortController();
    fetchLatestTranscript(controller.signal)
      .then((page) => alive && ready(page))
      .catch(() => alive && ready(parseTranscriptPage([])));
    return () => {
      alive = false;
      controller.abort();
      latestReconcileControllerRef.current?.abort();
      latestReconcileControllerRef.current = null;
      olderLoadControllerRef.current?.abort();
      olderLoadControllerRef.current = null;
    };
  }, [applyAuthoritativeSnapshot, fetchLatestTranscript, metadataStatusRef, onSnapshotRunning, openFreshPreview, pushFreshEvent, sessionKey]);

  useEffect(() => {
    if (tailStartId === undefined) return;
    return subscribe(peonId, sid, (frame) => {
    if (frame.event === "tailEnd" || frame.event === "tailError") {
      tailUnhealthyRef.current = true;
      onQueueChange();
      return;
    }
    lastTailActivityAtRef.current = Date.now();
    tailUnhealthyRef.current = false;
    if (frame.event === "change") {
      onQueueChange();
      return;
    }
    let event: Ev;
    try {
      event = JSON.parse(frame.data) as Ev;
    } catch {
      event = { type: "_raw", text: frame.data };
    }
    const tailEventId = paginationSupported && frame.id ? frame.id : null;
    const tailId = paginationSupported ? null : numericTailId(frame.id);
    if (tailId !== null) tailHighWaterRef.current = Math.max(tailHighWaterRef.current, tailId);
    if (!historyReadyRef.current) {
      pendingLiveRef.current.push({ event, tailId, tailEventId });
      return;
    }
    if (pushFreshEvent(event, tailId, tailEventId)) openFreshPreview(event);
    }, paginationSupported ? tailStartId : undefined);
  }, [onQueueChange, openFreshPreview, paginationSupported, peonId, pushFreshEvent, sid, subscribe, tailStartId]);

  useEffect(() => {
    if (!running) return;
    let alive = true;
    let inFlight = false;
    const reconcile = async () => {
      if (!alive || inFlight || !historyReadyRef.current) return;
      const now = Date.now();
      const mode = transcriptReconcileMode({
        now,
        running,
        historyReady: historyReadyRef.current,
        tailUnhealthy: tailUnhealthyRef.current,
        lastTailActivityAt: lastTailActivityAtRef.current,
        lastReconcileAt: lastFallbackReconcileAtRef.current,
      });
      if (mode === "none") return;
      if (latestReconcileControllerRef.current) return;
      inFlight = true;
      lastFallbackReconcileAtRef.current = now;
      const controller = new AbortController();
      latestReconcileControllerRef.current = controller;
      try {
        const session = await api<{ status?: string | null }>(`${base}/sessions/${encodeURIComponent(sid)}`, { signal: controller.signal });
        if (!alive) return;
        metadataStatusRef.current.set(sessionKey, session.status ?? null);
        if (mode === "transcript" || session.status !== "running") {
          const result = await fetchLatestTranscript(controller.signal);
          if (!alive) return;
          applyAuthoritativeSnapshot(result);
        }
        if (session.status !== "running") onRunFinished();
      } catch {
        // A transient poll failure must not disturb a healthy live tail.
      } finally {
        if (latestReconcileControllerRef.current === controller) latestReconcileControllerRef.current = null;
        inFlight = false;
      }
    };
    const timer = window.setInterval(reconcile, TAIL_FALLBACK_CHECK_MS);
    void reconcile();
    return () => {
      alive = false;
      window.clearInterval(timer);
      latestReconcileControllerRef.current?.abort();
      latestReconcileControllerRef.current = null;
    };
  }, [applyAuthoritativeSnapshot, base, fetchLatestTranscript, metadataStatusRef, onRunFinished, running, sessionKey, sid]);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    const current = loadedTranscriptRef.current;
    const cursor = current?.paginated ? current.nextCursor : null;
    if (!current?.paginated || !current.hasMore || !cursor || olderLoadInFlightRef.current) return false;
    olderLoadInFlightRef.current = true;
    const controller = replaceTranscriptRequest(olderLoadControllerRef.current);
    olderLoadControllerRef.current = controller;
    setLoadingOlder(true);
    setOlderLoadError(false);
    try {
      const page = parseTranscriptPage(await api<TranscriptResponse>(
        transcriptPageUrl(base, sid, true, cursor),
        { signal: controller.signal },
      ));
      if (reconciliationSessionRef.current !== sessionKey || !page.paginated) return false;
      if (page.hasMore && page.nextCursor === cursor) throw new Error("Peon repeated a transcript cursor");
      const merged = prependOlderPage(loadedTranscriptRef.current ?? current, page);
      loadedTranscriptRef.current = merged;
      historyEventIdsRef.current = new Set(merged.events.flatMap((event) => eventId(event) ?? []));
      setHistory(merged.events);
      setHasOlder(merged.hasMore && merged.nextCursor !== null);
      return true;
    } catch {
      if (reconciliationSessionRef.current === sessionKey) setOlderLoadError(true);
      return false;
    } finally {
      if (olderLoadControllerRef.current === controller) olderLoadControllerRef.current = null;
      olderLoadInFlightRef.current = false;
      if (reconciliationSessionRef.current === sessionKey) setLoadingOlder(false);
    }
  }, [base, sessionKey, sid]);

  const orderedLive = useMemo(() => orderLiveEvents(live), [live]);
  return {
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
  };
}
