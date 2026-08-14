import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { initDb, query } from "../../infrastructure/db/index.js";
import { bus, readEventsSince } from "../../infrastructure/events/index.js";
import { eventVisible, type AccessClient } from "../access/index.js";
import {
  claimSessionSyncGeneration,
  releaseSessionSyncGeneration,
} from "./index.js";
import {
  claimTranscriptGeneration,
  commitSnapshotCoveredTranscriptEvent,
  commitTranscriptDeletion,
  commitTranscriptEvent,
  commitTranscriptSnapshot,
  getTranscriptState,
  pruneTranscriptProjection,
  readTranscriptAfter,
  readTranscriptPage,
  releaseTranscriptGeneration,
  TRANSCRIPT_UNKNOWN_BOUNDARY_REPLAY,
  TranscriptProjectionError,
} from "./index.js";

async function database(): Promise<void> {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
}

async function claim(peonId: string, sessionId: string, generation: string, workspaceId = "ws"): Promise<void> {
  await claimSessionSyncGeneration(peonId, generation);
  await claimTranscriptGeneration({ workspaceId, peonId, sessionId, generation });
}

function envelope(seq: number, eventId = `event-${seq}`) {
  return {
    seq,
    eventId,
    event: {
      type: seq % 2 ? "assistant" : "result",
      text: `event ${seq}`,
      eventId,
      createdAt: 1_000 + seq,
      reverseTranscript: {
        epoch: "epoch-1",
        revision: seq,
        seq,
        eventType: seq % 2 ? "assistant" : "result",
        createdAt: 1_000 + seq,
        author: null,
        usage: seq === 2 ? { output_tokens: 7 } : null,
        artifactRefs: [],
      },
    },
  };
}

test("transcript snapshots publish atomically and paginate without presenting a rejected partial replacement", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 2,
    barrierSeq: 2,
    events: [envelope(1), envelope(2)],
  });

  const newest = await readTranscriptPage({ peonId: "p1", sessionId: "s1", limit: 1, online: true });
  assert.deepEqual(newest?.events.map((event) => event.eventId), ["event-2"]);
  assert.equal(newest?.hasMore, true);
  assert.equal(newest?.freshness.state, "ready");
  assert.equal(newest?.events[0]?.createdAt, 1_002);
  assert.deepEqual((newest?.events[0]?.reverseTranscript as { usage?: unknown }).usage, { output_tokens: 7 });

  const older = await readTranscriptPage({
    peonId: "p1",
    sessionId: "s1",
    limit: 1,
    cursor: newest!.nextCursor!,
    online: true,
  });
  assert.deepEqual(older?.events.map((event) => event.eventId), ["event-1"]);
  assert.equal(older?.hasMore, false);

  await assert.rejects(
    commitTranscriptSnapshot({
      workspaceId: "ws",
      peonId: "p1",
      sessionId: "s1",
      generation: "generation-1",
      epoch: "epoch-2",
      revision: 2,
      barrierSeq: 2,
      events: [envelope(2), envelope(1)],
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "TRANSCRIPT_GAP",
  );
  await assert.rejects(
    commitTranscriptSnapshot({
      workspaceId: "ws",
      peonId: "p1",
      sessionId: "s1",
      generation: "generation-1",
      epoch: "epoch-2",
      revision: 3,
      barrierSeq: 3,
      events: [envelope(1), envelope(3)],
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "TRANSCRIPT_GAP",
  );
  assert.deepEqual(
    (await readTranscriptAfter({ peonId: "p1", sessionId: "s1" })).map((event) => event.eventId),
    ["event-1", "event-2"],
  );
  assert.equal((await getTranscriptState("p1", "s1"))?.epoch, "epoch-1");
});

test("live transcript commit, browser event, inbox cursor, replay dedupe, and gap rollback are one durable boundary", async () => {
  await database();
  await query(
    `INSERT INTO sessions
       (peon_id,session_id,project_key,project_id,raw,synced_at)
     VALUES ('p1','s1','private','project-private','{}',1)`,
  );
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 2,
    barrierSeq: 2,
    events: [envelope(1), envelope(2)],
  });

  const busEvent = once(bus, "event");
  const live = {
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    transcriptEpoch: "epoch-1",
    seq: 3,
    revision: 3,
    eventId: "event-3",
    event: envelope(3).event,
    deliveryEpoch: "delivery-1",
    deliveryCursor: "cursor-3",
    messageId: "00000000-0000-4000-8000-000000000003",
  };
  const committed = await commitTranscriptEvent(live);
  assert.equal(committed.delivery.acknowledgedCursor, "cursor-3");
  const [published] = await busEvent as [{ kind: string; payload: unknown }];
  assert.equal(published.kind, "transcript");
  assert.equal((published.payload as { projectId?: string }).projectId, "project-private");

  const [delivery, transcript, inbox, browser] = await Promise.all([
    query<{ acknowledged_cursor: string }>(
      `SELECT acknowledged_cursor FROM peon_session_sync WHERE peon_id='p1'`,
    ),
    query<{ acknowledged_seq: number }>(
      `SELECT acknowledged_seq FROM peon_transcript_sync WHERE peon_id='p1' AND session_id='s1'`,
    ),
    query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM peon_session_inbox WHERE peon_id='p1'`),
    query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM events WHERE kind='transcript'`),
  ]);
  assert.equal(delivery.rows[0]?.acknowledged_cursor, "cursor-3");
  assert.equal(transcript.rows[0]?.acknowledged_seq, 3);
  assert.equal(inbox.rows[0]?.count, 1);
  assert.equal(browser.rows[0]?.count, 1);

  await commitTranscriptEvent(live);
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM transcript_events WHERE peon_id='p1' AND session_id='s1'`,
  )).rows[0]?.count, 3);
  assert.equal((await readEventsSince("ws", 0)).filter((event) => event.kind === "transcript").length, 1);

  await assert.rejects(
    commitTranscriptEvent({
      ...live,
      seq: 5,
      revision: 5,
      eventId: "event-5",
      event: envelope(5).event,
      deliveryCursor: "cursor-5",
      messageId: "00000000-0000-4000-8000-000000000005",
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "TRANSCRIPT_GAP",
  );
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM peon_session_inbox WHERE cursor='cursor-5'`,
  )).rows[0]?.count, 0, "a rejected gap must not advance the shared inbox");
  assert.equal((await getTranscriptState("p1", "s1"))?.acknowledgedSeq, 3);
});

test("a durable retry adopts an exact transcript row orphaned from its inbox checkpoint", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [envelope(1)],
  });
  await query(
    `INSERT INTO transcript_events
       (peon_id,session_id,transcript_epoch,seq,event_id,payload,body_bytes,created_at)
     VALUES ('p1','s1','epoch-1',2,'event-2',$1,$2,1)`,
    [JSON.stringify(envelope(2).event), Buffer.byteLength(JSON.stringify(envelope(2).event))],
  );

  const recovered = await commitTranscriptEvent({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    transcriptEpoch: "epoch-1",
    seq: 2,
    revision: 2,
    eventId: "event-2",
    event: envelope(2).event,
    deliveryEpoch: "delivery",
    deliveryCursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000102",
  });

  assert.equal(recovered.delivery.acknowledgedCursor, "cursor-2");
  assert.equal(recovered.browserEvent, null);
  assert.equal((await getTranscriptState("p1", "s1"))?.acknowledgedSeq, 2);
  assert.equal((await getTranscriptState("p1", "s1"))?.eventCount, 2);
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM peon_session_inbox WHERE cursor='cursor-2'`,
  )).rows[0]?.count, 1);
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM transcript_events WHERE peon_id='p1' AND session_id='s1'`,
  )).rows[0]?.count, 2);
});

test("a durable event whose stable identity moved sequence requests authoritative repair", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [envelope(1, "stable-event")],
  });
  const moved = envelope(1, "stable-event").event;

  await assert.rejects(
    commitTranscriptEvent({
      workspaceId: "ws",
      peonId: "p1",
      sessionId: "s1",
      generation: "generation-1",
      transcriptEpoch: "epoch-1",
      seq: 2,
      revision: 2,
      eventId: "stable-event",
      event: {
        ...moved,
        reverseTranscript: { ...moved.reverseTranscript, seq: 2, revision: 2 },
      },
      deliveryEpoch: "delivery",
      deliveryCursor: "moved-cursor-2",
      messageId: "00000000-0000-4000-8000-000000000103",
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "TRANSCRIPT_GAP",
  );
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM peon_session_inbox WHERE cursor='moved-cursor-2'`,
  )).rows[0]?.count, 0);
});

test("snapshot and live transcript events recursively replace NUL without changing literal escape text", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  const poisonedKey = "nested\0key";
  const literalEscape = String.raw`\u0000`;
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [{
      ...envelope(1),
      event: {
        ...envelope(1).event,
        text: "snapshot\0text",
        metadata: {
          [poisonedKey]: ["array\0value", { literalEscape }],
        },
      },
    }],
  });
  await commitTranscriptEvent({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    transcriptEpoch: "epoch-1",
    seq: 2,
    revision: 2,
    eventId: "event-2",
    event: {
      ...envelope(2).event,
      text: "live\0text",
      metadata: { deep: { value: "\0", literalEscape } },
    },
    deliveryEpoch: "delivery",
    deliveryCursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000002",
  });
  await commitTranscriptEvent({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    transcriptEpoch: "epoch-1",
    seq: 3,
    revision: 3,
    eventId: "event-3",
    event: envelope(3).event,
    deliveryEpoch: "delivery",
    deliveryCursor: "cursor-3",
    messageId: "00000000-0000-4000-8000-000000000003",
  });

  const stored = await query<{ seq: number; payload: Record<string, unknown> }>(
    `SELECT seq,payload FROM transcript_events
     WHERE peon_id='p1' AND session_id='s1' ORDER BY seq`,
  );
  assert.equal(JSON.stringify(stored.rows).includes("\0"), false);
  assert.equal(stored.rows[0]?.payload.text, "snapshot\uFFFDtext");
  const snapshotMetadata = stored.rows[0]?.payload.metadata as Record<string, unknown>;
  assert.deepEqual(snapshotMetadata["nested\uFFFDkey"], [
    "array\uFFFDvalue",
    { literalEscape },
  ]);
  assert.equal(stored.rows[1]?.payload.text, "live\uFFFDtext");
  assert.deepEqual(stored.rows[1]?.payload.metadata, {
    deep: { value: "\uFFFD", literalEscape },
  });
  assert.equal((await getTranscriptState("p1", "s1"))?.acknowledgedSeq, 3);
  assert.equal((await query<{ acknowledged_cursor: string }>(
    `SELECT acknowledged_cursor FROM peon_session_sync WHERE peon_id='p1'`,
  )).rows[0]?.acknowledged_cursor, "cursor-3");
  assert.deepEqual(
    (await readTranscriptAfter({ peonId: "p1", sessionId: "s1" })).map((event) => event.eventId),
    ["event-1", "event-2", "event-3"],
  );
});

test("durable replay requires the projected row and compares canonical normalized payloads", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [envelope(1)],
  });
  const base = envelope(2).event;
  const live = {
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    transcriptEpoch: "epoch-1",
    seq: 2,
    revision: 2,
    eventId: "event-2",
    event: { ...base, metadata: { alpha: 1, beta: 2 } },
    deliveryEpoch: "delivery-1",
    deliveryCursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000002",
  };
  await commitTranscriptEvent(live);
  await commitTranscriptEvent({
    ...live,
    event: { ...base, metadata: { beta: 2, alpha: 1 } },
  });

  await query(
    `DELETE FROM transcript_events
     WHERE peon_id='p1' AND session_id='s1' AND transcript_epoch='epoch-1' AND seq=2`,
  );
  await assert.rejects(
    commitTranscriptEvent(live),
    (error) => error instanceof TranscriptProjectionError && error.code === "REPLAY_MISMATCH",
  );
  assert.equal((await query<{ acknowledged_cursor: string | null }>(
    `SELECT acknowledged_cursor FROM peon_session_sync WHERE peon_id='p1'`,
  )).rows[0]?.acknowledged_cursor, "cursor-2");
});

test("an inbox identity without its projected transcript row cannot be acknowledged", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [envelope(1)],
  });
  await query(
    `INSERT INTO peon_session_inbox (peon_id,epoch,cursor,created_at,message_id)
     VALUES ('p1','delivery-1','cursor-2',1,'00000000-0000-4000-8000-000000000002')`,
  );
  await assert.rejects(
    commitTranscriptEvent({
      workspaceId: "ws",
      peonId: "p1",
      sessionId: "s1",
      generation: "generation-1",
      transcriptEpoch: "epoch-1",
      seq: 2,
      revision: 2,
      eventId: "event-2",
      event: envelope(2).event,
      deliveryEpoch: "delivery-1",
      deliveryCursor: "cursor-2",
      messageId: "00000000-0000-4000-8000-000000000002",
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "REPLAY_MISMATCH",
  );
  assert.equal((await query<{ acknowledged_cursor: string | null }>(
    `SELECT acknowledged_cursor FROM peon_session_sync WHERE peon_id='p1'`,
  )).rows[0]?.acknowledged_cursor, null);
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM transcript_events
     WHERE peon_id='p1' AND session_id='s1' AND seq=2`,
  )).rows[0]?.count, 0);
});

test("snapshot-covered durable events match projected identity and payload before cursor commit", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 2,
    barrierSeq: 2,
    events: [envelope(1), envelope(2)],
  });
  await commitSnapshotCoveredTranscriptEvent({
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    transcriptEpoch: "epoch-1",
    seq: 2,
    eventId: "event-2",
    event: envelope(2).event,
    deliveryEpoch: "delivery",
    deliveryCursor: "covered-2",
    messageId: "00000000-0000-4000-8000-000000000022",
  });
  await assert.rejects(
    commitSnapshotCoveredTranscriptEvent({
      peonId: "p1",
      sessionId: "s1",
      generation: "generation-1",
      transcriptEpoch: "epoch-1",
      seq: 2,
      eventId: "event-2",
      event: { ...envelope(2).event, text: "conflicting payload" },
      deliveryEpoch: "delivery",
      deliveryCursor: "covered-mismatch-payload",
      messageId: "00000000-0000-4000-8000-000000000023",
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "REPLAY_MISMATCH",
  );
  await assert.rejects(
    commitSnapshotCoveredTranscriptEvent({
      peonId: "p1",
      sessionId: "s1",
      generation: "generation-1",
      transcriptEpoch: "epoch-1",
      seq: 2,
      eventId: "wrong-event-id",
      event: { ...envelope(2).event, eventId: "wrong-event-id" },
      deliveryEpoch: "delivery",
      deliveryCursor: "covered-mismatch-id",
      messageId: "00000000-0000-4000-8000-000000000024",
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "REPLAY_MISMATCH",
  );
  assert.equal((await query<{ acknowledged_cursor: string }>(
    `SELECT acknowledged_cursor FROM peon_session_sync WHERE peon_id='p1'`,
  )).rows[0]?.acknowledged_cursor, "covered-2");
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM peon_session_inbox
     WHERE cursor IN ('covered-mismatch-payload','covered-mismatch-id')`,
  )).rows[0]?.count, 0);
});

test("snapshot-covered durable event self-heals when its stable identity moved sequence", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 2,
    barrierSeq: 2,
    events: [envelope(1, "stable-event"), envelope(2, "other-event")],
  });
  const moved = envelope(1, "stable-event").event;
  const reverse = moved.reverseTranscript;
  const committed = await commitSnapshotCoveredTranscriptEvent({
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    transcriptEpoch: "epoch-1",
    seq: 2,
    eventId: "stable-event",
    event: {
      ...moved,
      reverseTranscript: { ...reverse, seq: 2, revision: 2 },
    },
    deliveryEpoch: "delivery",
    deliveryCursor: "moved-covered-2",
    messageId: "00000000-0000-4000-8000-000000000025",
  });

  assert.equal(committed.delivery.acknowledgedCursor, "moved-covered-2");
  assert.equal((await query<{ acknowledged_cursor: string }>(
    `SELECT acknowledged_cursor FROM peon_session_sync WHERE peon_id='p1'`,
  )).rows[0]?.acknowledged_cursor, "moved-covered-2");
});

test("pagination cursors are bound to their Peon and session even when epochs match", async () => {
  await database();
  await claimSessionSyncGeneration("p1", "generation-1");
  for (const sessionId of ["s1", "s2"]) {
    await claimTranscriptGeneration({
      workspaceId: "ws",
      peonId: "p1",
      sessionId,
      generation: "generation-1",
    });
    await commitTranscriptSnapshot({
      workspaceId: "ws",
      peonId: "p1",
      sessionId,
      generation: "generation-1",
      epoch: "shared-epoch",
      revision: 2,
      barrierSeq: 2,
      events: [envelope(1), envelope(2)],
    });
  }
  const firstPage = await readTranscriptPage({
    peonId: "p1",
    sessionId: "s1",
    limit: 1,
    online: true,
  });
  assert.ok(firstPage?.nextCursor);
  await assert.rejects(
    readTranscriptPage({
      peonId: "p1",
      sessionId: "s2",
      limit: 1,
      cursor: firstPage.nextCursor,
      online: true,
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "BAD_CURSOR",
  );
});

test("a restarted connection resumes the committed transcript and a stale generation cannot append", async () => {
  await database();
  await claim("p1", "s1", "generation-old");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-old",
    epoch: "epoch-1",
    revision: 1,
    barrierSeq: 1,
    events: [envelope(1)],
  });
  await releaseTranscriptGeneration("p1", "generation-old");
  await releaseSessionSyncGeneration("p1", "generation-old");
  const offline = await readTranscriptPage({
    peonId: "p1",
    sessionId: "s1",
    limit: 50,
    online: false,
  });
  assert.deepEqual(offline?.events.map((event) => event.eventId), ["event-1"]);
  assert.equal(offline?.freshness.state, "offline");

  await claim("p1", "s1", "generation-new");
  assert.equal((await getTranscriptState("p1", "s1"))?.acknowledgedSeq, 1);
  await assert.rejects(
    claimTranscriptGeneration({
      workspaceId: "ws",
      peonId: "p1",
      sessionId: "s1",
      generation: "generation-old",
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "STALE_GENERATION",
  );
  await assert.rejects(
    commitTranscriptEvent({
      workspaceId: "ws",
      peonId: "p1",
      sessionId: "s1",
      generation: "generation-old",
      transcriptEpoch: "epoch-1",
      seq: 2,
      revision: 2,
      eventId: "stale",
      event: envelope(2, "stale").event,
      deliveryEpoch: "delivery",
      deliveryCursor: "stale-cursor",
      messageId: "00000000-0000-4000-8000-000000000010",
    }),
    (error) => error instanceof TranscriptProjectionError && error.code === "STALE_GENERATION",
  );
  await commitTranscriptEvent({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-new",
    transcriptEpoch: "epoch-1",
    seq: 2,
    revision: 2,
    eventId: "event-2",
    event: envelope(2).event,
    deliveryEpoch: "delivery",
    deliveryCursor: "cursor-2",
    messageId: "00000000-0000-4000-8000-000000000011",
  });
  assert.deepEqual(
    (await readTranscriptAfter({ peonId: "p1", sessionId: "s1", lastEventId: "event-1" }))
      .map((event) => event.eventId),
    ["event-2"],
  );
});

test("a resume boundary this projection does not hold replays one bounded newest window", async () => {
  await database();
  await claim("p1", "s1", "generation-1");
  const total = TRANSCRIPT_UNKNOWN_BOUNDARY_REPLAY + 12;
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: total,
    barrierSeq: total,
    events: Array.from({ length: total }, (_, index) => envelope(index + 1)),
  });
  // The boundary of another session is exactly as unknown here as an evicted
  // one, and that is the case that used to replay the whole transcript.
  const replay = await readTranscriptAfter({ peonId: "p1", sessionId: "s1", lastEventId: "event-of-another-session" });
  assert.equal(replay.length, TRANSCRIPT_UNKNOWN_BOUNDARY_REPLAY);
  assert.equal(replay[0]!.eventId, `event-${total - TRANSCRIPT_UNKNOWN_BOUNDARY_REPLAY + 1}`);
  assert.equal(replay[replay.length - 1]!.eventId, `event-${total}`);
  // A known boundary still resumes strictly after it, and no boundary at all
  // keeps replaying the retained transcript.
  assert.deepEqual(
    (await readTranscriptAfter({ peonId: "p1", sessionId: "s1", lastEventId: `event-${total - 2}` }))
      .map((event) => event.eventId),
    [`event-${total - 1}`, `event-${total}`],
  );
  assert.equal((await readTranscriptAfter({ peonId: "p1", sessionId: "s1" })).length, total);
});

test("bounded retention evicts complete least-recently-used transcripts and deterministically rebuilds on demand", async () => {
  await database();
  await claimSessionSyncGeneration("p1", "generation-1");
  for (const sessionId of ["old", "new"]) {
    await claimTranscriptGeneration({ workspaceId: "ws", peonId: "p1", sessionId, generation: "generation-1" });
    await commitTranscriptSnapshot({
      workspaceId: "ws",
      peonId: "p1",
      sessionId,
      generation: "generation-1",
      epoch: `epoch-${sessionId}`,
      revision: 1,
      barrierSeq: 1,
      events: [{ ...envelope(1, `${sessionId}-1`), event: { ...envelope(1, `${sessionId}-1`).event, eventId: `${sessionId}-1` } }],
    });
  }
  await query(`UPDATE peon_transcript_sync SET last_accessed_at=1 WHERE session_id='old'`);
  await query(`UPDATE peon_transcript_sync SET last_accessed_at=2 WHERE session_id='new'`);
  assert.equal(await pruneTranscriptProjection(1, Number.MAX_SAFE_INTEGER), 1);
  assert.equal((await getTranscriptState("p1", "old"))?.status, "evicted");
  assert.equal(await readTranscriptPage({ peonId: "p1", sessionId: "old", limit: 50, online: true }), null);
  assert.deepEqual(
    (await readTranscriptAfter({ peonId: "p1", sessionId: "new" })).map((event) => event.eventId),
    ["new-1"],
  );
  assert.equal((await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM transcript_events WHERE session_id='old'`,
  )).rows[0]?.count, 0);
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "old",
    generation: "generation-1",
    epoch: "epoch-old",
    revision: 1,
    barrierSeq: 1,
    events: [{
      ...envelope(1, "old-rebuilt"),
      event: { ...envelope(1, "old-rebuilt").event, eventId: "old-rebuilt" },
    }],
  });
  assert.equal((await getTranscriptState("p1", "old"))?.status, "ready");
  assert.deepEqual(
    (await readTranscriptAfter({ peonId: "p1", sessionId: "old" })).map((event) => event.eventId),
    ["old-rebuilt"],
  );
});

test("transcript browser events honor project ACLs and deletion is a terminal committed event", async () => {
  await database();
  await query(
    `INSERT INTO sessions
       (peon_id,session_id,project_key,project_id,raw,synced_at)
     VALUES ('p1','s1','private','project-private','{}',1)`,
  );
  await claim("p1", "s1", "generation-1");
  await commitTranscriptSnapshot({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    epoch: "epoch-1",
    revision: 0,
    barrierSeq: 0,
    events: [],
  });
  await commitTranscriptDeletion({
    workspaceId: "ws",
    peonId: "p1",
    sessionId: "s1",
    generation: "generation-1",
    transcriptEpoch: "epoch-1",
    deliveryEpoch: "delivery",
    deliveryCursor: "cursor-delete",
    messageId: "00000000-0000-4000-8000-000000000020",
  });
  const deleted = (await readEventsSince("ws", 0)).find((event) => event.kind === "transcript")!;
  const visible: AccessClient = {
    userId: "member",
    workspaceId: "ws",
    role: "member",
    allowedPeons: new Set(["p1"]),
    allowedProjects: new Map([["p1", new Set(["id:project-private"])]]),
    tails: new Map(),
  };
  const hidden: AccessClient = {
    ...visible,
    allowedProjects: new Map([["p1", new Set(["id:other-project"])]]),
  };
  assert.equal(eventVisible(visible, deleted), true);
  assert.equal(eventVisible(hidden, deleted), false);
  assert.equal((deleted.payload as { deleted?: boolean }).deleted, true);
  assert.equal(await getTranscriptState("p1", "s1"), null);
});
