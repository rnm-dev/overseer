import type { Ev } from "./parsing";

export interface PendingEcho {
  clientId: string;
  text: string;
  author?: string;
  createdAt: number;
  baselineTailId: number | null;
}

export function numericTailId(value: string | null | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function sameUserMessage(event: Ev, pending: PendingEcho): boolean {
  if (event.type !== "user_message") return false;
  // Author/email/login are presentation metadata, not message identity. An
  // authoritative Overseer snapshot carries the exact idempotency key; live Peon
  // frames fall back to text plus their strictly-new SSE position.
  if (typeof event.commandId === "string") return event.commandId === pending.clientId;
  return event.text === pending.text;
}

export function canTailCommitPending(tailId: number | null, pending: PendingEcho): boolean {
  return tailId !== null && pending.baselineTailId !== null && tailId > pending.baselineTailId;
}

export function canLiveCommitPending(
  event: Ev,
  pending: PendingEcho,
  tailId: number | null,
  tailEventId: string | null,
): boolean {
  if (!sameUserMessage(event, pending)) return false;
  // A supplied command ID is authoritative (sameUserMessage already rejected a
  // mismatch). Current durable Peon tail payloads omit it, but their event ID is
  // guaranteed to be newer than the snapshot boundary used to open the stream.
  return event.commandId === pending.clientId
    || tailEventId !== null
    || canTailCommitPending(tailId, pending);
}

export function orderLiveEvents(events: Ev[]): Ev[] {
  return events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const position = (event: Ev): number => {
        if (typeof event._tailId === "number") return event._tailId;
        // A zero baseline means there is no numeric legacy-tail position to sort
        // against. This is also the normal value for durable opaque-ID tails,
        // whose already-rendered events intentionally retain insertion order.
        // Giving that optimistic row position 0.5 would briefly move it above
        // all durable live events until the authoritative refresh arrived.
        if (typeof event._baselineTailId === "number" && event._baselineTailId > 0) return event._baselineTailId + 0.5;
        return Number.POSITIVE_INFINITY;
      };
      return position(a.event) - position(b.event) || a.index - b.index;
    })
    .map(({ event }) => event);
}

/**
 * History and live state are updated independently. During reconciliation the
 * authoritative row can reach history one render before its optimistic/tail
 * counterpart is removed from live. Filter that overlap at the render boundary
 * so one committed user command can never produce two visible bubbles.
 */
export function combineVisibleTranscriptEvents(history: Ev[], live: Ev[]): Ev[] {
  const historyEventIds = new Set(history.flatMap((event) => (
    typeof event.eventId === "string" && event.eventId ? [event.eventId] : []
  )));
  const historyCommandIds = new Set(history.flatMap((event) => (
    event.type === "user_message" && typeof event.commandId === "string" && event.commandId
      ? [event.commandId]
      : []
  )));
  return [
    ...history,
    ...live.filter((event) => {
      if (typeof event._tailEventId === "string" && historyEventIds.has(event._tailEventId)) return false;
      return event.type !== "user_message"
        || typeof event.commandId !== "string"
        || !historyCommandIds.has(event.commandId);
    }),
  ];
}

/**
 * Replace live rows with the authoritative, timestamp-enriched transcript.
 * Numeric SSE ids are one-based transcript positions. This is deliberately
 * positional rather than payload-based: two identical messages are still two
 * different rows, while a timestamp added by Overseer does not create a copy.
 */
export function reconcileAuthoritativeSnapshot(
  events: Ev[],
  live: Ev[],
  pending: PendingEcho[],
): { live: Ev[]; pending: PendingEcho[]; matchedClientIds: Set<string> } {
  const matchedClientIds = new Set<string>();
  const usedEventIds = new Set<number>();

  for (const echo of pending) {
    // Without a baseline, rescan the whole authoritative transcript on every
    // refresh. The first snapshot may already contain the new Peon row before
    // Overseer's follow-up record is committed and able to enrich its timestamp;
    // a later same-length snapshot must still be able to match it.
    const minimumId = echo.baselineTailId ?? 0;
    for (let index = minimumId; index < events.length; index++) {
      const eventId = index + 1;
      if (usedEventIds.has(eventId)) continue;
      const event = events[index]!;
      if (!sameUserMessage(event, echo)) continue;

      // A send made before the first history request completed has no trustworthy
      // positional baseline. In that one case require the server-side timestamp
      // to be near the optimistic send time, avoiding a match to an old repeated
      // message with identical text.
      if (echo.baselineTailId === null) {
        if (typeof event.createdAt !== "number" || Math.abs(event.createdAt - echo.createdAt) > 60_000) continue;
      }

      usedEventIds.add(eventId);
      matchedClientIds.add(echo.clientId);
      break;
    }
  }

  return {
    live: live.filter((event) => {
      if (event._clientId && matchedClientIds.has(event._clientId)) return false;
      return typeof event._tailId !== "number" || event._tailId > events.length;
    }),
    pending: pending.filter((echo) => !matchedClientIds.has(echo.clientId)),
    matchedClientIds,
  };
}

/** Reconcile capable Peons by durable event identity rather than array position. */
export function reconcileDurableSnapshot(
  events: Ev[],
  live: Ev[],
  pending: PendingEcho[],
): { live: Ev[]; pending: PendingEcho[]; matchedClientIds: Set<string> } {
  const snapshotIds = new Set(events.flatMap((event) => typeof event.eventId === "string" && event.eventId ? [event.eventId] : []));
  const matchedClientIds = new Set<string>();
  const usedEventIds = new Set<string>();

  for (const echo of pending) {
    for (const event of events) {
      const id = typeof event.eventId === "string" ? event.eventId : "";
      if (id && usedEventIds.has(id)) continue;
      if (!sameUserMessage(event, echo)) continue;
      const exactCommand = event.commandId === echo.clientId;
      if (!exactCommand && (typeof event.createdAt !== "number" || Math.abs(event.createdAt - echo.createdAt) > 60_000)) continue;
      if (id) usedEventIds.add(id);
      matchedClientIds.add(echo.clientId);
      break;
    }
  }

  return {
    live: live.filter((event) => {
      if (event._clientId && matchedClientIds.has(event._clientId)) return false;
      return typeof event._tailEventId !== "string" || !snapshotIds.has(event._tailEventId);
    }),
    pending: pending.filter((echo) => !matchedClientIds.has(echo.clientId)),
    matchedClientIds,
  };
}
