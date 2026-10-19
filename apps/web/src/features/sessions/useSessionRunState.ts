import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { indexedRunAssumptionDelay, shouldSeedIndexedRun } from "./runStatus";
import { activeRunReducer, initialActiveRun } from "./sessionRunState";

interface Args {
  sessionKey: string;
  sid: string;
  peonId: string;
  /** The indexed summary's status for this session, if the sidebar has it. */
  indexedStatus: string | null | undefined;
  onSessionRunningChange?: (peonId: string, sid: string, running: boolean, at: number) => void;
  /** Ask for the session record to be re-read. Must be stable. */
  refreshMetadata: () => void;
}

export type SessionRunState = ReturnType<typeof useSessionRunState>;

/**
 * Whether a run is currently active — gates the Stop button. Seeded from the
 * session record, flipped on by sending a followup, off by a `result` frame.
 */
export function useSessionRunState({ sessionKey, sid, peonId, indexedStatus, onSessionRunningChange, refreshMetadata }: Args) {
  // The indexed summary is already on screen with the sidebar. Use it as the
  // cache-first answer instead of hiding activity until the direct metadata
  // request (or a transcript run signal) wins its independent request race.
  const [activeRun, dispatch] = useReducer(activeRunReducer, undefined, () => initialActiveRun(sessionKey, indexedStatus, Date.now()));
  const running = activeRun.sessionKey === sessionKey && activeRun.running;
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
      indexedStatus,
      metadataStatusKnown: metadataStatusRef.current.has(sessionKey),
      runRevision: runRevisionRef.current.get(sessionKey) ?? 0,
      refuted: refutedRunRef.current.has(sessionKey),
    })) return;
    dispatch({ type: "seed-indexed", sessionKey, now: Date.now() });
  }, [indexedStatus, sessionKey]);

  const setRunning = useCallback((next: boolean) => {
    // Only a live signal — a sent follow-up or a tail frame — turns a run back
    // on, and that is exactly what makes the Peon's record trustworthy again.
    if (next) refutedRunRef.current.delete(sessionKey);
    unconfirmedRunRef.current.delete(sessionKey);
    runRevisionRef.current.set(sessionKey, (runRevisionRef.current.get(sessionKey) ?? 0) + 1);
    dispatch({ type: "set-running", sessionKey, running: next });
    onSessionRunningChange?.(peonId, sid, next, Date.now());
  }, [onSessionRunningChange, peonId, sessionKey, sid]);

  const refreshMetadataForObservedRun = useCallback(() => {
    if (observedRunMetadataRefreshRef.current.has(sessionKey)) return;
    observedRunMetadataRefreshRef.current.add(sessionKey);
    refreshMetadata();
  }, [refreshMetadata, sessionKey]);

  const onLiveRunningChange = useCallback((next: boolean) => {
    if (next) refreshMetadataForObservedRun();
    else observedRunMetadataRefreshRef.current.delete(sessionKey);
    setRunning(next);
  }, [refreshMetadataForObservedRun, sessionKey, setRunning]);

  // Model and effort always travel together: they describe the same turn, and
  // the activity indicator reports both.
  const setRunningSelection = useCallback((model: string | null, reasoningEffort: string | null) => {
    dispatch({ type: "set-selection", sessionKey, model, reasoningEffort });
  }, [sessionKey]);

  useEffect(() => {
    if (activeRun.sessionKey !== sessionKey || !activeRun.running) return;
    const delay = indexedRunAssumptionDelay(Date.now(), activeRun.assumedAt);
    if (delay === null) return;
    const timer = window.setTimeout(() => dispatch({ type: "retire-assumed", sessionKey }), delay);
    return () => window.clearTimeout(timer);
  }, [activeRun.assumedAt, activeRun.running, activeRun.sessionKey, sessionKey]);

  const onSnapshotRunning = useCallback(() => {
    // A transcript whose last event is a run signal describes the same stuck
    // record the Peon already refuted; it is not evidence of live work.
    if (refutedRunRef.current.has(sessionKey)) return;
    refreshMetadataForObservedRun();
    unconfirmedRunRef.current.add(sessionKey);
    dispatch({ type: "snapshot-running", sessionKey });
  }, [refreshMetadataForObservedRun, sessionKey]);

  /** A turn ended; the next observed run may refresh metadata again. */
  const clearObservedRun = useCallback(() => {
    observedRunMetadataRefreshRef.current.delete(sessionKey);
  }, [sessionKey]);

  /** The Peon refused a cancel because nothing was running. */
  const refuteRun = useCallback(() => {
    refutedRunRef.current.add(sessionKey);
  }, [sessionKey]);

  /** Mark the start of a record read; pass the result to the apply functions. */
  const metadataRevision = useCallback(() => runRevisionRef.current.get(sessionKey) ?? 0, [sessionKey]);

  const applyMetadataStatus = useCallback((revision: number, record: { status?: string | null; model?: string | null; reasoningEffort?: string | null }) => {
    metadataStatusRef.current.set(sessionKey, record.status ?? null);
    // Do not let a metadata request that started before a local/live run
    // transition overwrite that newer transition when its response arrives.
    if ((runRevisionRef.current.get(sessionKey) ?? 0) !== revision) return;
    const peonRunning = record.status === "running";
    // A record still claiming a run the Peon itself refused stays refused.
    if (!peonRunning || !refutedRunRef.current.has(sessionKey)) setRunning(peonRunning);
    if (peonRunning) setRunningSelection(record.model ?? null, record.reasoningEffort ?? null);
  }, [sessionKey, setRunning, setRunningSelection]);

  const applyMetadataFailure = useCallback((revision: number) => {
    // The record could not be read at all — a Peon this Overseer can no
    // longer reach over HTTP answers nothing here. Silence is not evidence
    // of live work, so withdraw a run only the transcript implied instead of
    // leaving an indicator and a Stop button that can never succeed. Record
    // the absent status too, so a snapshot landing later stays quiet.
    metadataStatusRef.current.set(sessionKey, null);
    if ((runRevisionRef.current.get(sessionKey) ?? 0) !== revision) return;
    if (unconfirmedRunRef.current.has(sessionKey)) {
      setRunning(false);
    } else {
      // An indexed cache seed is useful only while its direct confirmation
      // is pending. A stated transport failure retires it before the TTL.
      dispatch({ type: "retire-assumed", sessionKey });
    }
  }, [sessionKey, setRunning]);

  return useMemo(() => ({
    running,
    runningModel,
    runningReasoningEffort,
    setRunning,
    setRunningSelection,
    onLiveRunningChange,
    onSnapshotRunning,
    clearObservedRun,
    refuteRun,
    metadataStatusRef,
    metadataRevision,
    applyMetadataStatus,
    applyMetadataFailure,
  }), [applyMetadataFailure, applyMetadataStatus, clearObservedRun, metadataRevision, onLiveRunningChange, onSnapshotRunning, refuteRun, running, runningModel, runningReasoningEffort, setRunning, setRunningSelection]);
}
