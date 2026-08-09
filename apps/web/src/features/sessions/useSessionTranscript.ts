import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { api } from "../../shared/api";
import type { TailFrame } from "../../realtime/liveSocket";
import { isAgentWorkUpdate } from "../../realtime/peonSounds";
import { latestRunSignal, runSignalFromEvent, sig, type Ev } from "./parsing";
import {
  numericTailId,
  orderLiveEvents,
  reconcileAuthoritativeSnapshot,
  reconcileDurableSnapshot,
} from "./transcriptMerge";
import type { PreviewTarget } from "./PreviewPanel";
import {
  eventId,
  mergeNewestPage,
  pagesOverlap,
  parseTranscriptPage,
  prependOlderPage,
  tailResumeBoundary,
  transcriptPageUrl,
  type TailStart,
  type LoadedTranscript,
  type TranscriptPage,
  type TranscriptResponse,
} from "./transcriptPagination";
import {
  TAIL_FALLBACK_CHECK_MS,
  replaceTranscriptRequest,
  snapshotEndsRun,
  transcriptReconcileMode,
} from "./transcriptReconciliation";
import {
  cachedTranscriptSnapshot,
  preparedTranscriptSnapshot,
  rememberTranscriptSnapshot,
} from "./transcriptSnapshotCache";

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
  const initialSnapshotRef = useRef(
    cachedTranscriptSnapshot(base, sid, paginationSupported),
  );
  const [history, setHistory] = useState<Ev[] | null>(
    () => initialSnapshotRef.current?.events ?? null,
  );
  const [live, setLive] = useState<Ev[]>([]);
  const [showHistorySpinner, setShowHistorySpinner] = useState(false);
  const [historyLoadError, setHistoryLoadError] = useState(false);
  const [hasOlder, setHasOlder] = useState(
    () => Boolean(initialSnapshotRef.current?.hasMore && initialSnapshotRef.current.nextCursor),
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderLoadError, setOlderLoadError] = useState(false);
  // null means the initial snapshot is not ready yet; a resolved boundary of null
  // means the snapshot has no durable one. Waiting closes the fetch→tail race
  // without replaying history. The boundary carries the session it was read from:
  // `sid` changes one render before the reset effect runs, and a boundary handed
  // to the wrong session is unknown there, which makes Overseer replay the whole
  // transcript rather than resume. A cache hit may paint immediately, but it
  // is not the opening boundary.
  // Wait for the current HTTP newest-page request before starting the tail.
  const [tailStart, setTailStart] = useState<TailStart | null>(null);
  const historyReadyRef = useRef(initialSnapshotRef.current !== null);
  const historyLengthRef = useRef(initialSnapshotRef.current?.paginated ? 0 : initialSnapshotRef.current?.events.length ?? 0);
  const loadedTranscriptRef = useRef<LoadedTranscript | null>(initialSnapshotRef.current);
  const historyEventIdsRef = useRef<Set<string>>(
    new Set(initialSnapshotRef.current?.events.flatMap((event) => eventId(event) ?? []) ?? []),
  );
  const seenTailIdsRef = useRef<Set<number>>(new Set());
  const seenTailEventIdsRef = useRef<Set<string>>(new Set());
  const seenRef = useRef<Set<string>>(new Set());
  const pendingLiveRef = useRef<Array<{ event: Ev; tailId: number | null; tailEventId: string | null }>>([]);
  const olderLoadInFlightRef = useRef(false);
  // Read by callbacks the fetch/tail effects must not depend on: making them
  // depend on `running` would tear the tail down on every run transition.
  const runningRef = useRef(running);
  runningRef.current = running;
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
    // new route cannot inherit the previous session's tail position.
    reconciliationSessionRef.current = sessionKey;
    historyReadyRef.current = false;
    historyLengthRef.current = 0;
    loadedTranscriptRef.current = null;
    historyEventIdsRef.current = new Set();
    seenTailIdsRef.current = new Set();
    seenTailEventIdsRef.current = new Set();
    seenRef.current = new Set();
    pendingLiveRef.current = [];
    lastTailActivityAtRef.current = Date.now();
    tailUnhealthyRef.current = false;
    lastFallbackReconcileAtRef.current = null;
    latestReconcileControllerRef.current?.abort();
    latestReconcileControllerRef.current = null;
    olderLoadControllerRef.current?.abort();
    olderLoadControllerRef.current = null;
  }

  // One freshness gate for every inbound frame: a reconnect replays frames this
  // browser has already rendered, and a run signal or a sound must not fire for
  // a turn that already happened.
  const alreadyDelivered = useCallback((event: Ev, tailId: number | null, tailEventId: string | null): boolean => {
    if (tailEventId !== null) return historyEventIdsRef.current.has(tailEventId) || seenTailEventIdsRef.current.has(tailEventId);
    if (tailId !== null) return tailId <= historyLengthRef.current || seenTailIdsRef.current.has(tailId);
    return seenRef.current.has(sig(event));
  }, []);

  const markDelivered = useCallback((event: Ev, tailId: number | null, tailEventId: string | null): void => {
    if (tailEventId !== null) seenTailEventIdsRef.current.add(tailEventId);
    else if (tailId !== null) seenTailIdsRef.current.add(tailId);
    else seenRef.current.add(sig(event));
  }, []);

  const appendLive = useCallback((event: Ev, tailId: number | null, tailEventId: string | null): void => {
    setLive((previous) => [...previous, {
      ...event,
      ...(tailEventId !== null ? { _tailEventId: tailEventId } : {}),
      ...(tailId !== null ? { _tailId: tailId } : {}),
      createdAt: event.type === "user_message" && typeof event.createdAt !== "number" ? Date.now() : event.createdAt,
    }]);
  }, []);

  const pushFreshEvent = useCallback((event: Ev, tailId: number | null = null, tailEventId: string | null = null): boolean => {
    if (alreadyDelivered(event, tailId, tailEventId)) return false;
    markDelivered(event, tailId, tailEventId);
    appendLive(event, tailId, tailEventId);
    const signal = runSignalFromEvent(event);
    if (signal === "running") onRunningChange(true);
    else if (signal === "idle") onRunFinished(event);
    if (isAgentWorkUpdate(event)) onAgentUpdate(event);
    return true;
  }, [alreadyDelivered, appendLive, markDelivered, onAgentUpdate, onRunFinished, onRunningChange]);

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
    setLive((current) => (page.paginated
      ? reconcileDurableSnapshot(page.events, current)
      : reconcileAuthoritativeSnapshot(page.events, current)));
    const merged = mergeNewestPage(loadedTranscriptRef.current, page);
    rememberTranscriptSnapshot(base, sid, paginationSupported, page);
    loadedTranscriptRef.current = merged;
    historyLengthRef.current = merged.paginated ? 0 : merged.events.length;
    historyEventIdsRef.current = new Set(merged.events.flatMap((event) => eventId(event) ?? []));
    for (const event of page.events) seenRef.current.add(sig(event));
    setHasOlder(merged.paginated && merged.hasMore && merged.nextCursor !== null);
    setHistory(merged.events);
    if (snapshotEndsRun(runningRef.current, page.events)) onRunFinished();
  }, [base, onRunFinished, paginationSupported, sid]);

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
    seenTailIdsRef.current = new Set();
    seenTailEventIdsRef.current = new Set();
    seenRef.current = new Set();
    pendingLiveRef.current = [];
    olderLoadInFlightRef.current = false;
    latestReconcileControllerRef.current?.abort();
    latestReconcileControllerRef.current = null;
    olderLoadControllerRef.current?.abort();
    olderLoadControllerRef.current = null;
    lastTailActivityAtRef.current = Date.now();
    tailUnhealthyRef.current = false;
    lastFallbackReconcileAtRef.current = null;
    const cached = cachedTranscriptSnapshot(base, sid, paginationSupported);
    if (cached) {
      loadedTranscriptRef.current = cached;
      historyLengthRef.current = cached.paginated ? 0 : cached.events.length;
      historyEventIdsRef.current = new Set(cached.events.flatMap((event) => eventId(event) ?? []));
      setHistory(cached.events);
      setHasOlder(cached.paginated && cached.hasMore && cached.nextCursor !== null);
    } else {
      setHistory(null);
      setHasOlder(false);
    }
    setTailStart(null);
    historyReadyRef.current = false;
    setLive([]);
    setHistoryLoadError(false);
    setLoadingOlder(false);
    setOlderLoadError(false);
    const ready = (page: TranscriptPage) => {
      applyAuthoritativeSnapshot(page);
      setHistoryLoadError(false);
      setTailStart({
        sessionKey,
        id: page.paginated && page.events.length ? eventId(page.events[page.events.length - 1]!) : null,
      });
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
    const prepared = preparedTranscriptSnapshot(base, sid, paginationSupported);
    (prepared ?? fetchLatestTranscript(controller.signal))
      .then((page) => alive && ready(page))
      .catch(() => {
        if (!alive) return;
        // Without an authoritative newest window there is no safe eventId from
        // which to start the tail. Subscribe explicitly without one so the
        // server supplies its bounded recovery window; cached event IDs remove
        // overlap, while the history error still tells the operator that older
        // pagination could not be revalidated.
        historyReadyRef.current = true;
        setTailStart({ sessionKey, id: null });
        setHistoryLoadError(true);
      });
    return () => {
      alive = false;
      controller.abort();
      latestReconcileControllerRef.current?.abort();
      latestReconcileControllerRef.current = null;
      olderLoadControllerRef.current?.abort();
      olderLoadControllerRef.current = null;
    };
  }, [applyAuthoritativeSnapshot, base, fetchLatestTranscript, metadataStatusRef, onSnapshotRunning, openFreshPreview, paginationSupported, pushFreshEvent, sessionKey, sid]);

  useEffect(() => {
    const boundary = tailResumeBoundary(tailStart, sessionKey);
    if (!boundary.subscribe) return;
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
    if (!historyReadyRef.current) {
      pendingLiveRef.current.push({ event, tailId, tailEventId });
      return;
    }
    if (pushFreshEvent(event, tailId, tailEventId)) openFreshPreview(event);
    }, paginationSupported ? boundary.lastEventId : undefined);
  }, [onQueueChange, openFreshPreview, paginationSupported, peonId, pushFreshEvent, sessionKey, sid, subscribe, tailStart]);

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
    historyLoadError,
    hasOlder,
    loadingOlder,
    olderLoadError,
    loadOlder,
  };
}
