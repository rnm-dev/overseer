# overseer — working notes for Claude

The **fleet control plane** for [peon](../peon). One always-on service that holds
a registry of peons and drives many of them from a single place. Sibling repo to
`peon`; the wire contract between them lives in
[`PROTOCOL.md`](./PROTOCOL.md) — read it before touching anything
protocol-shaped.

## Locked decisions (2026-07-07)

These are settled — build toward them, don't relitigate without a reason:

- **Deploys to a public VPS with a domain.** The mobile app reaches it over the
  public internet (TLS), NOT via Tailscale-on-phone.
- **Two network faces — keep them separate.** The VPS *also* joins the tailnet
  so it can reach NAT'd peons. The **peon-facing** API (`/agent/v1/peons/*`
  register+heartbeat, plus the overseer→peon calls) stays **tailnet-only** —
  bind it to the tailnet interface, never expose the `fleetToken` endpoints to
  the internet. Only the **operator/mobile** API (`/fleet/*` + the WebSocket)
  goes **public, behind TLS + per-user/per-device auth**. A leaked `fleetToken`
  on the public net would let anyone impersonate a peon; the split keeps the
  fleet plane private and the internet-facing surface a single authenticated
  app. (Dual-bind is a deploy TODO — see roadmap; today it's one listener.)
- **Postgres is the single system-of-record.** Everything durable lives there
  (already in the peon stack — peon assigns a `pgPort` per project). Connect via
  `DATABASE_URL`. Schema is migration-managed in `db.ts`. **Redis is deliberately
  NOT used** until there's a second overseer instance to fan events between
  (then Redis pub/sub); at one instance, Postgres + `LISTEN/NOTIFY` covers it.
  Adding Redis early is more to break, against the stability goal.
- **Robustness is the top priority, mobile is first-class.** A phone drops
  connections constantly — disconnect/reconnect is the *normal* case. So: the
  overseer is a durable hub with a materialized session index + an event log
  with a monotonic cursor; clients resume from a cursor on reconnect; the peon
  stays source of truth so the index can always be rebuilt by pulling
  `/sessions`. See "Robustness model" below.

### Postgres schema (system-of-record)

Time columns are **BIGINT epoch-ms** (what peons emit — no conversion, no tz
ambiguity). JSON blobs are `jsonb`. Migrations live in `db.ts` (`MIGRATIONS`),
tracked in `schema_migrations`.

- `peons` — the registry (was registry.json): identity, observed `address`,
  `control_port`, `capabilities` (jsonb), `load` (jsonb), `last_seen`. Online is
  computed (`now - last_seen <= offlineAfterMs`), not stored.
- `sessions` — the aggregated index (materialized view; **cache, not truth**):
  `(peon_id, session_id)` PK, queryable columns (status/project/author/times) +
  a `raw` jsonb of the whole peon SessionRecord for detail. Rebuilt/refreshed by
  reconcile (pull) and, later, by event push.
- *(later steps)* `events` (append log, per-peon monotonic `seq` + a global
  cursor for client resume), `users`, `devices` (push tokens), `sessions`
  history.

### Robustness model (the whole point)

1. **Durable hub** — Postgres survives overseer restarts; on startup the
   overseer reconciles by pulling each online peon's `/sessions` into the
   index. Peon = source of truth ⇒ the index can never be permanently wrong.
2. **Gap-safe event pipeline** *(step 2 — DONE)* — peons push session events
   (`POST /agent/v1/peons/:id/events`, `ingestEvents` in `sessionIndex.ts`) with
   a per-peon monotonic `seq` + a boot `epoch`; a seq gap (dropped push) or an
   epoch change (peon restart) triggers a pull-reconcile, so a dropped/interrupted
   push channel never loses data. Per-peon cursor is `peons.last_event_epoch/seq`.
3. **Resumable clients** *(step 3)* — one authenticated WebSocket per app,
   multiplexing fleet + session tails + notifications; on every (re)connect the
   client sends its last cursor and gets snapshot + missed events. Ping/pong
   reaps dead sockets.
4. **Offline notifications** *(step 5)* — APNs/FCM push on `needs_human`/failure
   even with no socket open.
5. **Idempotency** — commands carry `Peon-Request-Id` (peon already dedupes on
   it) so a flaky-network retry never double-acts.

## The vision (where this is going)

- **Command all my peons from one place.** A peon is a worker box (VPS or an
  office desktop with no public IP) running Claude Code sessions. The overseer
  is the single pane of glass: list every peon, start/steer/cancel sessions on
  any of them, pause the fleet, push/pull files — without caring which box is
  where or whether it's behind NAT.
- **Aggregate everything.** "Show me every running session across all peons,"
  fleet-wide load, one activity feed. The overseer is where per-peon reality
  gets merged into one view.
- **Mobile app (future).** The operator API (`/fleet/*`) is meant to become the
  backend for a phone app — glance at the fleet, get a push when a session needs
  a human, fire off a follow-up from the couch. That goal shapes several
  decisions below (a stable public endpoint, real user auth, an event stream,
  and a materialized session index rather than always fanning out).

## How it works today

```
 operator/app ─/fleet/* (operatorApiKey)─► OVERSEER ─/agent/v1/* (fleetToken)─► peons
 peons ───────/agent/v1/peons/register + heartbeat (fleetToken)───────────────► OVERSEER
```

- **Transport is Tailscale.** No inbound reachability needed on a peon: it dials
  the overseer to register, and the overseer records the peon's tailnet
  address **from the source of that request** (`sourceAddress()` in
  `server.ts`). That's the whole NAT solution — never trust a peon's
  self-claimed address, only where its connection came from.
- **The overseer is the client for all control.** `/fleet/*` routes proxy
  through to a peon's `/agent/v1/*` (`peonClient.ts`). The one inbound thing
  peons do is register + heartbeat (discovery/liveness only).
- **Two secrets, two auth boundaries** (`config.ts`): `fleetToken` (shared with
  peons — accepts register/heartbeat *and* is the bearer the overseer presents
  when calling a peon) and `operatorApiKey` (humans/app on `/fleet/*`). Neither
  yields the other. Empty ⇒ that whole side 503s (fail-closed).
- **The overseer holds no session state.** The source of truth for a session
  is the peon it runs on. `registry.ts` stores only per-peon metadata + last
  heartbeat + last-reported load. Everything session-shaped is read back through
  the proxy on demand. **Keep this invariant** — if we add an aggregated session
  index (see below) it is a *cache/materialized view*, never the source of
  truth.

### Files & layout

- `config.ts` — env-only config (no runtime settings API; it's a service, not a
  per-user tool). `OVERSEER_PORT/HOST/FLEET_TOKEN/API_KEY/DATABASE_URL/OFFLINE_AFTER_MS/RECONCILE_INTERVAL_MS`.
- `db.ts` — Postgres pool (`DATABASE_URL`) + embedded migration runner
  (`MIGRATIONS`, tracked in `schema_migrations`). `query()` helper; `initDb()`
  connects + migrates; `setPool()` lets tests inject a `pg-mem` pool.
- `registry.ts` — peon registry, **Postgres-backed** (`peons` table), async.
  Derived `online` (last heartbeat within `offlineAfterMs`, default 45s) and
  `baseUrl`.
- `sessionIndex.ts` — the aggregated `sessions` index: `upsertSession`,
  `reconcilePeon`/`reconcileAll` (pull each online peon's `/sessions`),
  `listSessions` (filter by peon/status, paginated), and a periodic reconcile
  loop. Populated on startup + on each peon register + on the interval.
- `peonClient.ts` — the south-bound proxy: `callPeon` (JSON), `proxyStream`
  (SSE passthrough), `proxyFileDownload`/`proxyFileUpload` (streamed, Range +
  `Peon-Content-Sha256` forwarded). Unreachable peon ⇒ `502 PEON_UNREACHABLE`;
  the peon's own errors pass through verbatim.
- `server.ts` — the two routers (north-bound peons, south-facing `/fleet`) + the
  proxy route table.
- `index.ts` — bootstrap.

**No `dist/` is committed** (unlike peon, which has a git-install constraint
forcing it). Deploy = clone + `npm install` + `npm run compile` + `npm start`,
or `npm run dev` (tsx watch). If that ever changes (e.g. packaging a CLI), revisit.

## What's done

- Peon registry with self-registration, heartbeat, online/offline, JSON persistence.
- Operator `/fleet/*` API: list/get/delete peons, aggregate `/fleet/status`,
  proxied per-peon status / sessions (list, get, transcript, start, followup,
  cancel) / control (pause, resume) / SSE stream / file transfer (GET+PUT).
- Identity forwarding: operator's `X-Actor` → peon's `Peon-Actor` → session `author`.
- Tested end-to-end: **13/13** core loop + **8/8** file proxy (register, both
  auth boundaries, proxy round-trip, actor forwarding, aggregate, offline 502,
  download/Range/stat/upload/checksum). Tests are throwaway `tsx` scripts driving
  a stub peon + the real server; there's no committed test suite yet (**add one**
  — see below).

## Current status (handoff — 2026-07-07)

**Built, tested, committed** (Viktor takes it from here; the peon side is done
and frozen as a dependency — its contract is `PROTOCOL.md` (vendored)):

- **Registry** (`registry.ts`) — Postgres `peons` table; register/heartbeat,
  derived online/load. Peon address learned from the register request source.
- **Aggregated session index** (`sessionIndex.ts`) — Postgres `sessions` table,
  a *materialized view* of every peon's sessions. `GET /fleet/sessions`
  (filter by peon/status, paginated). Kept fresh two ways:
  - **reconcile** (pull each online peon's `/sessions`) on startup, on register,
    and on an interval — the durable baseline;
  - **event push** (`ingestEvents` ← `POST /agent/v1/peons/:id/events`) — the
    peon streams session-summary changes; gap (`seq`) / restart (`epoch`)
    detection triggers a reconcile. **Push for liveness, reconcile for
    correctness.** Cursor: `peons.last_event_epoch/last_event_seq`.
- **Operator API** (`server.ts`, `/fleet/*`, `operatorApiKey`) — list/get/delete
  peons, `/fleet/status` aggregate, `/fleet/sessions`, and proxied per-peon
  status / sessions / followup / cancel / control / SSE stream / file transfer.
- **Proxy** (`peonClient.ts`) — calls a peon's `/agent/v1` with the fleet bearer,
  forwards `X-Actor`→`Peon-Actor`; unreachable peon → `502 PEON_UNREACHABLE`.
- Verified with `pg-mem` tests (throwaway `tsx` scripts): registry CRUD, index
  dedup/filter/paginate, reconcile-on-register, event ingest (normal / gap /
  epoch-restart). **No committed suite yet — add one (roadmap).**

## Roadmap — what to build next

### Step 3 (next up): resumable WebSocket + event log — the mobile-critical piece

The index goes *live* but there's no way for a client to *subscribe* to it yet,
and no ordered stream to resume from after a reconnect. Two parts:

**3a. Append-only event log with a global cursor.** Today `ingestEvents` only
upserts the index in place; a resumable client needs an ordered log. Add:
```
events (
  cursor     BIGSERIAL PRIMARY KEY,   -- global monotonic = the client resume token
  peon_id    TEXT NOT NULL,
  session_id TEXT,
  kind       TEXT NOT NULL,           -- 'session' now; 'notification' etc. later
  payload    JSONB NOT NULL,          -- the session summary
  created_at BIGINT NOT NULL
)
```
Append a row wherever the index changes (`upsertSession` is the natural single
choke point). Prune beyond a cap so it stays bounded — old rows just mean a
resuming client that's too far behind gets a fresh snapshot instead of replay.

**3b. WebSocket multiplex** (`ws` package; one socket per app):
- Handshake auth (token in query/subprotocol → user; see step 4 — do it together).
- Client → `{type:"hello", cursor?, subscribe?:[sessionId]}`.
- Server → `{type:"snapshot", peons, sessions, cursor}` then replay every
  `events` row with `cursor > client.cursor`, then live-push new rows as they
  land. This is the resume: a backgrounded phone catches up in one round-trip.
- Live session tails: `{type:"subscribe", sessionId}` attaches the peon SSE
  (reuse `proxyStream` logic) and forwards frames tagged by session; unsubscribe
  to detach. Writes (followup/cancel) can ride the socket → translate to peon POST.
- Ping/pong heartbeat; close on pong timeout (reap dead mobile sockets fast).

### Step 4 (with 3): per-user / per-device auth

Replace the single `operatorApiKey` with `users` + `devices` (token hash,
user_id, device label, expiry, revoked) — borrow peon's `users.ts` /
`authSessions.ts` patterns. Validate in the WS handshake *and* on `/fleet/*`. A
lost phone → revoke that device only. Needed before the overseer goes public.

### Then

5. **APNs/FCM push notifications** + a device-token registry — fire on
   `needs_human`/failure events (that's *why* the event log exists). iOS/Android?
6. **Operator dashboard UI** — peon list + live load, unified session feed,
   per-session detail with the proxied tail. (Web; the mobile app is separate.)
7. **Admission / concurrency policy** — a peon runs sessions concurrently with
   **no ceiling** and only serializes *within* a session (interrupt-and-resume).
   Per-peon ceilings, per-session soft-locks, "who's steering this session"
   presence are the **overseer's** job (see PROTOCOL.md "control plane owns
   admission").
8. **Per-peon tokens** — one shared `fleetToken` today; per-peon secrets limit
   blast radius if a box is compromised.
9. **Dual-bind the two interfaces** (deploy) — peon-facing `/agent/v1/peons/*`
   on the tailnet interface only; `/fleet/*` + WS public behind TLS. Today it's
   one listener; split before going public (see "Locked decisions").
10. **A committed test suite** (`node --test`/vitest + `pg-mem`) replacing the
    throwaway scripts.

## Scaling: aggregating sessions across ~10 peons

The direct question: **"see all sessions from all peons at once — how does that
scale at ~10 peons?"** Short answer: **fan-out is completely fine at 10, and up
to a few dozen. You do not need anything fancier yet.** But the mobile app + a
*live* "everything" view are what eventually push you off fan-out. Two regimes:

> **Note:** we implemented Regime 2 (Postgres index + event push) directly,
> because robustness + mobile were the priorities. The two regimes below are kept
> for the reasoning; "what we have" now = the index, with reconcile as the
> fan-out-style backstop.

### Regime 1 — pull / fan-out (the reasoning; now the reconcile backstop)

`GET /fleet/sessions` = fire `GET /agent/v1/sessions` at every *online* peon
concurrently (`Promise.all`, exactly like `/fleet/status` already does) and
merge. At 10 peons that's 10 parallel tailnet requests; wall-clock ≈ the slowest
single peon (tens of ms on a tailnet). Cheap, **stateless, always fresh, nothing
to keep in sync.** Rules that keep it healthy — most already in place:

- **Skip offline peons** (already done in `/fleet/status`) so a dead box never
  costs a timeout.
- **Short per-peon timeout** on the fan-out (a couple seconds) so one slow peon
  can't stall the whole response; report it as a per-peon error, not a failure.
- **Cap concurrency** if the fleet ever grows (e.g. p-limit at ~16) — irrelevant
  at 10.
- **Summaries, not transcripts.** `/sessions` returns session records
  (id/status/preview/timestamps), never full transcripts. Keep aggregate
  payloads to summaries; fetch a transcript only when a specific session is
  opened. This is the single biggest lever on payload size.

Where fan-out gets uncomfortable (all beyond 10): **(a)** *live* updates — a
phone that wants a real-time feed can't poll 10 peons every second forever;
**(b)** polling frequency × peons grows linearly; **(c)** you can't send a mobile
push notification for "session needs a human" if nobody's holding a request open.
None of these bite at 10 with on-demand pulls, but the mobile app's "notify me"
and "live" wants are exactly (a)/(c).

### Regime 2 — push / materialized view (the direction, for live + mobile)

When you want live + notifications (not just on-demand lists), invert it: **peons
push session lifecycle events to the overseer**, which maintains an aggregated
**session index** (Postgres-backed, for query + restart durability). Then:

- `GET /fleet/sessions` is a single **local** query — O(1) fan-out, instant,
  paginated — independent of peon count. Scales to hundreds of peons trivially.
- The overseer can hold one SSE/WebSocket to the mobile app and push deltas as
  they arrive — the phone opens *one* connection, not N.
- `needs_human` / failure events become **push notifications** naturally.
- The index is a **cache**: on overseer restart, re-sync from each peon's
  `/sessions` (the peon stays source of truth — invariant above).

The plumbing already half-exists: the peon has the outbound channel
(`peonRegistrar.ts`) and PROTOCOL.md reserves a peon→overseer `events` push.
Realizing this = add `POST /agent/v1/peons/:id/events` on the overseer + emit
from the peon's `sessions` EventEmitter. **Do this when you build the mobile app
or want a live fleet feed — not before.** At 10 peons with a web dashboard that
polls `/fleet/sessions` every few seconds, plain fan-out is the right, simpler
choice.

**Rule of thumb:** fan-out for *on-demand* reads (fine to dozens of peons);
switch to push + materialized index when you need *live* aggregation or *mobile
notifications*. Hybrid is normal — keep fan-out for cold reads even after adding
the index.

## Suggestions / opinions

- **`GET /fleet/sessions` is served from the Postgres index** (step 1, done),
  refreshed by reconcile (pull). Fan-out-per-request was the earlier plan; with
  robustness+mobile as priorities we went straight to the durable index instead.
- **Design `/fleet/*` response shapes for the phone now.** Keep list endpoints
  paginated and summary-only from day one so the mobile app never has to
  re-shape them.
- **Decide the public-exposure model early** (Tailscale-on-phone vs public VPS +
  TLS) — it gates the auth work in roadmap #3.
- **Don't let the overseer accrete session logic.** It orchestrates and
  aggregates; the peon owns execution. If you're tempted to compute session
  state *in* the overseer, that's a smell — read it from the peon or from the
  event-fed index instead.

## Dev notes

- Express 5 + TS + ESM, `.js` import specifiers, matching peon conventions.
- **Express 5 gotcha:** `req.params.*` is typed `string | string[]` (wildcard
  support) — coerce with `String(...)`. Wildcard routes use `{*rest}` and give
  `req.params.rest` as a decoded segment array.
- **File uploads rely on `express.json()` ignoring non-JSON bodies** — a `PUT
  /fleet/.../files` must be `application/octet-stream` (or any non-json type) or
  the global json parser would consume the stream before the proxy can forward
  it. `proxyFileUpload` streams with `duplex: "half"`.
- Run: `npm run dev` (watch) or `compile && start`. Typecheck: `npm run typecheck`.
- Tests are currently ad-hoc `tsx` scripts (write one, run it, delete it) driving
  a stub peon HTTP server + the real `createServer()`. Replace with a committed
  suite (roadmap #7).
