import { useCallback, useEffect, useRef, useState } from "react";
import { indexedRunAssumptionDelay, shouldSeedIndexedRun } from "./runStatus";

interface Args {
  sid: string;
  peonId: string;
  /** The indexed summary's status for this session, if the sidebar has it. */
  indexedStatus: string | null | undefined;
  onSessionRunningChange?: (peonId: string, sid: string, running: boolean, at: number) => void;
  /** Ask for the session record to be re-read. Must be stable. */
  refreshMetadata: () => void;
}

interface ActiveRun {
  running: boolean;
  model: string | null;
  reasoningEffort: string | null;
  /** Set while the run is only assumed from the indexed summary. */
  assumedAt: number | null;
}

export type SessionRunState = ReturnType<typeof useSessionRunState>;

/**
 * Whether a run is currently active — gates the Stop button. Seeded from the
 * session record, flipped on by sending a followup, off by a `result` frame.
 */
export function useSessionRunState({ sid, peonId, indexedStatus, onSessionRunningChange, refreshMetadata }: Args) {
  // The indexed summary is already on screen with the sidebar. Use it as the
  // cache-first answer instead of hiding activity until the direct metadata
  // request (or a transcript run signal) wins its independent request race.
  const [activeRun, setActiveRun] = useState<ActiveRun>(() => {
    const running = indexedStatus === "running";
    return { running, model: null, reasoningEffort: null, assumedAt: running ? Date.now() : null };
  });
  const runRevisionRef = useRef(0);
  const observedRunMetadataRefreshRef = useRef(false);
  /** The last status a session record reported; undefined until one is read. */
  const metadataStatusRef = useRef<string | null | undefined>(undefined);
  // A Peon that refuses a cancel with SESSION_NOT_RUNNING has told us something
  // stronger than its own session record does: that record can be left at
  // "running" by a run whose process vanished, and re-reading it would keep
  // resurrecting the indicator we just cleared. So the refusal outranks the
  // record until the session produces live work again.
  const refutedRunRef = useRef(false);
  // A run this page only inferred from the transcript, with nothing having
  // confirmed it. The inference reads "the newest event is not a result", which
  // is also true of a turn whose process vanished, so it must never outlive the
  // record read that was supposed to settle it.
  const unconfirmedRunRef = useRef(false);

  const retireAssumed = useCallback(() => {
    setActiveRun((previous) => previous.assumedAt !== null
      ? { running: false, model: null, reasoningEffort: null, assumedAt: null }
      : previous);
  }, []);

  useEffect(() => {
    // The sidebar page can finish hydrating after this route mounts. Promote
    // its running summary only while no direct/live evidence has arrived; the
    // metadata GET and tail remain authoritative and can immediately clear it.
    if (!shouldSeedIndexedRun({
      indexedStatus,
      metadataStatusKnown: metadataStatusRef.current !== undefined,
      runRevision: runRevisionRef.current,
      refuted: refutedRunRef.current,
    })) return;
    const now = Date.now();
    setActiveRun((previous) => previous.running ? previous : { running: true, model: null, reasoningEffort: null, assumedAt: now });
  }, [indexedStatus]);

  const setRunning = useCallback((next: boolean) => {
    // Only a live signal — a sent follow-up or a tail frame — turns a run back
    // on, and that is exactly what makes the Peon's record trustworthy again.
    if (next) refutedRunRef.current = false;
    unconfirmedRunRef.current = false;
    runRevisionRef.current += 1;
    setActiveRun((previous) => ({
      running: next,
      model: next ? previous.model : null,
      reasoningEffort: next ? previous.reasoningEffort : null,
      assumedAt: null,
    }));
    onSessionRunningChange?.(peonId, sid, next, Date.now());
  }, [onSessionRunningChange, peonId, sid]);

  const refreshMetadataForObservedRun = useCallback(() => {
    if (observedRunMetadataRefreshRef.current) return;
    observedRunMetadataRefreshRef.current = true;
    refreshMetadata();
  }, [refreshMetadata]);

  const onLiveRunningChange = useCallback((next: boolean) => {
    if (next) refreshMetadataForObservedRun();
    else observedRunMetadataRefreshRef.current = false;
    setRunning(next);
  }, [refreshMetadataForObservedRun, setRunning]);

  // Model and effort always travel together: they describe the same turn, and
  // the activity indicator reports both.
  const setRunningSelection = useCallback((model: string | null, reasoningEffort: string | null) => {
    setActiveRun((previous) => ({ ...previous, model, reasoningEffort }));
  }, []);

  useEffect(() => {
    if (!activeRun.running) return;
    const delay = indexedRunAssumptionDelay(Date.now(), activeRun.assumedAt);
    if (delay === null) return;
    const timer = window.setTimeout(retireAssumed, delay);
    return () => window.clearTimeout(timer);
  }, [activeRun.assumedAt, activeRun.running, retireAssumed]);

  const onSnapshotRunning = useCallback(() => {
    // A transcript whose last event is a run signal describes the same stuck
    // record the Peon already refuted; it is not evidence of live work.
    if (refutedRunRef.current) return;
    refreshMetadataForObservedRun();
    unconfirmedRunRef.current = true;
    setActiveRun((previous) => ({ ...previous, running: true }));
  }, [refreshMetadataForObservedRun]);

  /** A turn ended; the next observed run may refresh metadata again. */
  const clearObservedRun = useCallback(() => {
    observedRunMetadataRefreshRef.current = false;
  }, []);

  /** The Peon refused a cancel because nothing was running. */
  const refuteRun = useCallback(() => {
    refutedRunRef.current = true;
  }, []);

  /** Mark the start of a record read; pass the result to the apply functions. */
  const metadataRevision = useCallback(() => runRevisionRef.current, []);

  /** Note a record's status without applying it to the run (e.g. a recovery read). */
  const noteMetadataStatus = useCallback((status: string | null | undefined) => {
    metadataStatusRef.current = status ?? null;
  }, []);

  /** The last status a record reported; undefined until one has been read. */
  const metadataStatus = useCallback(() => metadataStatusRef.current, []);

  const applyMetadataStatus = useCallback((revision: number, record: { status?: string | null; model?: string | null; reasoningEffort?: string | null }) => {
    metadataStatusRef.current = record.status ?? null;
    // Do not let a metadata request that started before a local/live run
    // transition overwrite that newer transition when its response arrives.
    if (runRevisionRef.current !== revision) return;
    const peonRunning = record.status === "running";
    // A record still claiming a run the Peon itself refused stays refused.
    if (!peonRunning || !refutedRunRef.current) setRunning(peonRunning);
    if (peonRunning) setRunningSelection(record.model ?? null, record.reasoningEffort ?? null);
  }, [setRunning, setRunningSelection]);

  const applyMetadataFailure = useCallback((revision: number) => {
    // The record could not be read at all — a Peon this Overseer can no
    // longer reach over HTTP answers nothing here. Silence is not evidence
    // of live work, so withdraw a run only the transcript implied instead of
    // leaving an indicator and a Stop button that can never succeed. Record
    // the absent status too, so a snapshot landing later stays quiet.
    metadataStatusRef.current = null;
    if (runRevisionRef.current !== revision) return;
    if (unconfirmedRunRef.current) {
      setRunning(false);
    } else {
      // An indexed cache seed is useful only while its direct confirmation
      // is pending. A stated transport failure retires it before the TTL.
      retireAssumed();
    }
  }, [retireAssumed, setRunning]);

  return {
    running: activeRun.running,
    runningModel: activeRun.model,
    runningReasoningEffort: activeRun.reasoningEffort,
    setRunning,
    setRunningSelection,
    onLiveRunningChange,
    onSnapshotRunning,
    clearObservedRun,
    refuteRun,
    metadataRevision,
    metadataStatus,
    noteMetadataStatus,
    applyMetadataStatus,
    applyMetadataFailure,
  };
}
