# Full remote-control surface (handoff 2026-07-08, part 2)

## Done this pass
- FIX: liveSocket crash — `send()` on a CONNECTING socket (subscribe before open).
  Guarded + `onopen` flushes/re-subscribes active tails (survives reconnects).
- Backend proxies (server.ts), all verified: `DELETE /sessions/:id`; projects
  `GET :key` / `POST` / `POST import` / `PATCH` / `DELETE` / `:key/setup` /
  `:key/verify` / `suggest-dir`; `GET /integrations` + `/integrations/:key/projects`.
  Actor forwarded on all writes. suggest-dir ordered before :key.
- Frontend safe bits: session delete (409→"cancel first"), eventCount (missing⇒
  unknown, not 0), shared `isPeonNeedsUpdate` capability helper (DRY'd rename too).

## Blocked on peon devs → tasks/peon-questions.md (Viktor forwarding)
- Projects CRUD UI (detail card + create/import/edit/delete + setup/verify→tail)
  needs authoritative GET /projects/:key + /integrations shapes. Local PROTOCOL.md
  is stale (same as /stats was). Build once shapes come back.
- Parity #1 (transcript/files on workspace family): already satisfied here.

---

# Wire up new peon /agent/v1 endpoints (handoff 2026-07-08)

Peon added: GET /stats, PATCH /sessions/:id (rename), GET/PATCH safe settings,
GET /projects, and agentAuth in /status. Overseer must proxy + surface them.

## State of play (verified against the box)
- projects / settings (GET+PATCH) proxies + UI: ALREADY built.
- Parity #1 (transcript+files on the workspace family): ALREADY satisfied — there
  is only ONE proxy family (`/api/workspaces/:wsId/peons/:id/*`) and it already has
  both transcript and files. No `/fleet`, no `:linkId`, no legacy family on this box
  (the `/fleet`→`/api` rename already happened — see old todo). FLAGGED to user.

## Backend (src/server.ts)
- [ ] GET  `${wp}/stats` — proxy, forward `?period=`.
- [ ] PATCH `${wp}/sessions/:sid` — proxy rename, body `{ title }`.
- [ ] Admission gating on POST `${wp}/sessions`: fetch peon `/status`, block only
      when `agentAuth.authState` ∈ {broken, unauthenticated}. Allow ok/unknown/absent
      (backward-compatible). 409 AGENT_UNAVAILABLE.
- [ ] Capability fallback: keep straight relay; peon 404 (old peon) handled in UI
      (404 → "needs update"), matching the existing projects/settings pattern.

## Frontend (web/src)
- [ ] PeonDashboard: surface `agentAuth` (health card + warning banner when broken).
- [ ] New PeonStats page + tab + route; period switcher; totals + outcomes; 404 fallback.
- [ ] PeonSessionDetail: inline session rename (PATCH), 404 fallback.
- [ ] i18n en+ru keys for all of the above.

## Verify
- [x] typecheck backend + web clean.

## Review (DONE — 2026-07-08)
Backend (`src/server.ts`): added `GET ${wp}/stats` (forwards `?period=`),
`PATCH ${wp}/sessions/:sid` (rename, forwards actor+body), and `agentAuthBlocked()`
gating on `POST ${wp}/sessions` — refuses (409 AGENT_UNAVAILABLE) only when the
peon's `/status` reports `agentAuth.authState` ∈ {broken, unauthenticated};
ok/unknown/absent pass (backward-compatible with un-upgraded peons).

Frontend: `PeonDashboard` surfaces `agentAuth` (health card + red warning banner
when broken/unauth; hidden entirely on older peons that don't report it). New
`PeonStats` page/tab/route with day|yesterday|week|month switcher, totals grid,
and a generic outcomes breakdown — rendered defensively (optional chaining) since
the peon's exact `/stats` JSON isn't vendored here. `PeonSessionDetail` gains
inline rename (PATCH, empty clears). All new surfaces do 404 → "needs update".
i18n en+ru added.

Verified: backend `tsc --noEmit` clean; web `tsc` clean except the pre-existing
`vite.config.ts` @types/node gap (untouched); API boots + `/healthz` ok.

## Flags for Viktor
- Email's parity #1 (transcript/files missing on the workspace family) is a
  no-op here — one family, already has both; `/fleet`/`:linkId` is stale naming.
- `PeonStats` shape CONFIRMED against peon `SessionStats` (flat, no `totals`
  wrapper): `sessionCount`, `totalTokens/CostUsd/DurationMs`, `outcomeCounts{}`.
  Adds token breakdown (never summed — `totalTokens` already folds in cache) and
  a `sessionsMissingUsage` cost caveat.
- No session-create UI in the web yet, so admission gating currently only guards
  the API (mobile/future). Adding a start-session button? It should also read
  `agentAuth` to disable itself when the CLI is bad.
- Couldn't exercise the proxy against a live peon (no Tailscale/peon on nid-dev).
