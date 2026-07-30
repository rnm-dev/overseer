import type { Ev } from "./parsing";

export function numericTailId(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * A transcript row is only ever Peon's own. The composer shows a spinner until
 * its HTTP request settles and renders nothing of its own, so live rows carry a
 * durable event ID (or, on a legacy Peon, a numeric tail position) and sort by
 * it. Frames a Peon emits without either keep their arrival order.
 */
export function orderLiveEvents(events: Ev[]): Ev[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const position = (event: Ev): number =>
        typeof event._tailId === "number" ? event._tailId : Number.POSITIVE_INFINITY;
      return position(a.event) - position(b.event) || a.index - b.index;
    })
    .map(({ event }) => event);
}

/**
 * History and live state are updated independently. During reconciliation the
 * authoritative row can reach history one render before its live counterpart is
 * removed. Filter that overlap at the render boundary so one committed event can
 * never produce two visible rows.
 */
export function combineVisibleTranscriptEvents(history: Ev[], live: Ev[]): Ev[] {
  const historyEventIds = new Set(history.flatMap((event) => (
    typeof event.eventId === "string" && event.eventId ? [event.eventId] : []
  )));
  return [
    ...history,
    ...live.filter((event) => typeof event._tailEventId !== "string" || !historyEventIds.has(event._tailEventId)),
  ];
}

/**
 * Drop the live rows the authoritative, timestamp-enriched transcript now owns.
 * Numeric SSE ids are one-based transcript positions, so a snapshot of N events
 * supersedes every live row up to position N. This is deliberately positional
 * rather than payload-based: two identical messages are still two different
 * rows, while a timestamp added by Overseer does not create a copy.
 */
export function reconcileAuthoritativeSnapshot(events: Ev[], live: Ev[]): Ev[] {
  return live.filter((event) => typeof event._tailId !== "number" || event._tailId > events.length);
}

/** Reconcile capable Peons by durable event identity rather than array position. */
export function reconcileDurableSnapshot(events: Ev[], live: Ev[]): Ev[] {
  const snapshotIds = new Set(events.flatMap((event) => typeof event.eventId === "string" && event.eventId ? [event.eventId] : []));
  return live.filter((event) => typeof event._tailEventId !== "string" || !snapshotIds.has(event._tailEventId));
}
