# Overseer server — settled decisions and the robustness model

Why the API is built the way it is. The rules for organising the code are in
[architecture](architecture.md); the box it runs on is in [the dev
box](dev-box.md); the wire contract with Peon is `apps/server/PROTOCOL.md` —
read it before touching anything protocol-shaped.

Overseer is the **fleet control plane**: one always-on service holding a
registry of Peons and driving many of them from a single place.

## Locked decisions (2026-07-07, still in force)

Build toward these; don't relitigate without a reason.

- **Public VPS with a domain.** The mobile app reaches Overseer over the public
  internet with TLS, not over Tailscale-on-phone.
- **Two network faces, kept separate.** The host also joins the tailnet so it
  can reach NAT'd Peons. The Peon-facing plane stays tailnet-only; only the
  operator/mobile API and the WebSocket are public, behind TLS and
  per-user/per-device auth. A machine credential must never be reachable from
  the internet.
- **Postgres is the single system-of-record.** Everything durable lives there,
  reached through `DATABASE_URL`, with migrations embedded in `db.ts`
  (`MIGRATIONS`, tracked in `schema_migrations`) applied on boot under an
  advisory lock. Time columns are BIGINT epoch-ms — what Peons emit, so no
  conversion and no timezone ambiguity. **Redis is deliberately not used** until
  there is a second Overseer instance to fan events between; at one instance
  Postgres plus `LISTEN/NOTIFY` covers it, and adding Redis early is just more
  to break.
- **Robustness first, mobile is first-class.** A phone drops connections
  constantly, so disconnect and reconnect are the *normal* case, not the error
  path.
- **Peon owns execution; Overseer orchestrates and aggregates.** Every
  session-shaped projection Overseer keeps is a cache that can be rebuilt by
  asking the Peon again. If you are tempted to compute session state *in*
  Overseer, that is the smell — read it from the Peon or from the event-fed
  projection instead.

## Robustness model

1. **Durable hub.** Postgres survives restarts; on startup Overseer reconciles
   by pulling from each online Peon. Peon is the source of truth, so a
   projection can never be permanently wrong.
2. **Gap-safe event pipeline.** Peons push lifecycle events carrying a per-Peon
   monotonic `seq` and a boot `epoch`. A gap (dropped push) or an epoch change
   (Peon restart) triggers a pull-reconcile, so an interrupted channel never
   loses data.
3. **Resumable clients.** One authenticated socket per app, multiplexing fleet
   state, session tails and notifications; on every reconnect the client sends
   its last cursor and receives a snapshot plus the events it missed. Ping/pong
   reaps dead sockets.
4. **Offline notification.** Push delivery covers the case where no socket is
   open at all — see [push notifications](push-notifications.md).
5. **Idempotency.** Commands carry `Peon-Request-Id`, which Peon dedupes on, so
   a flaky-network retry never double-acts.

Points 1–4 are the reason the projections exist. Their current contracts are in
[resource synchronization](resource-synchronization.md), [session catalog
synchronization](session-list-sync.md) and [transcript
synchronization](transcript-sync.md).

## Fan-out versus a materialized projection

Reading every Peon on demand (`Promise.all` across the online ones, skip the
offline, short per-Peon timeout, summaries never transcripts) is fine to a few
dozen Peons and stays the reconcile backstop. What pushes past it is not fleet
size but *liveness*: a phone cannot poll N Peons forever, and nobody can be
notified that a session needs a human if no request is being held open.

So Overseer went straight to the projection — a durable local index fed by Peon
pushes, queried locally, with reconcile as the correctness net. **Push for
liveness, reconcile for correctness.** Keep fan-out for cold reads; the hybrid
is intended, not a transitional state.

## Server conventions

- Express 5 + TypeScript + ESM with `.js` import specifiers, matching Peon.
- **Express 5 gotcha:** `req.params.*` is typed `string | string[]` because of
  wildcard support — coerce with `String(...)`. Wildcard routes are `{*rest}`
  and give `req.params.rest` as a decoded segment array.
- **File uploads rely on `express.json()` ignoring non-JSON bodies.** A file
  `PUT` must be `application/octet-stream` (or any non-JSON type), or the global
  JSON parser consumes the stream before the proxy can forward it. Streamed
  proxying uses `duplex: "half"`.

## What this page deliberately no longer carries

The 2026-07-07 handoff status, the file-by-file layout and the roadmap that
followed it were removed on 2026-08-12: every step in that roadmap shipped, and
a stale "next up" list is worse than none. What replaced each item:

| Then | Now |
| --- | --- |
| Step 3 — resumable WebSocket + event log | [transcript synchronization](transcript-sync.md), [session catalog synchronization](session-list-sync.md), [resource synchronization](resource-synchronization.md) |
| Step 4 — per-user/per-device auth | [sign-in methods](sign-in-methods.md) |
| Step 5 — APNs/FCM push | [push notifications](push-notifications.md) |
| Step 6 — operator dashboard | the web dashboard in `apps/web`, and the Flutter client in [client documentation](client/index.md) |
| Step 8 — per-Peon tokens | per-Peon, workspace-scoped credentials; there is no shared fleet secret |
| Step 9 — dual-bind the two faces | [trusted client IPs](proxy-trust.md) and the reverse-control cutover gates |
| Step 10 — a committed test suite | committed workspace suites plus the [protocol conformance harness](protocol-conformance-harness.md) |
