# Questions for the peon devs — Projects/Integrations wire shapes

Building the overseer Projects tab against `/agent/v1`. The backend proxies are
wired; the UI needs authoritative response/request shapes (our vendored
PROTOCOL.md predates these endpoints). Please confirm exact field names + types —
casing bugs are what bite us. Grouped by endpoint.

## 1. Casing — the big one
`POST /projects` and `/projects/import` bodies use **`setUp?`** (capital U), but
`GET /projects/:key` and `PATCH /projects/:key` use **`setup`** (lowercase). Is
that intentional (write=`setUp`, read/patch=`setup`), or a typo? Which casing is
authoritative for each direction?

## 2. GET /projects/:key — detail card
Full shape please, with types + nullability. The email listed
`label, scope, dir, info, setup, isSetUp, integrationLabel…` — what's under the "…"?
Specifically:
- `key`, `label`, `dir` (absolute path?), `info` (freeform string?)
- `scope` — what are the possible values and what does it mean?
- `setup` — a command string? multiline script? object?
- `isSetUp: boolean` — and is there a verify counterpart (e.g. `isVerified` /
  `canVerify`)? How does the UI know verify is allowed vs. "run setup first"?
- `integrationKey` + `integrationLabel` — null for manual projects?
- Does the detail card also carry the rollup counts (`sessionCount`,
  `activeCount`, `lastActivityMs`) or are those list-only?

## 3. Create / import — request + response
- `POST /projects` body: confirm `{ label, dir?, info?, setUp? }`. Is `label`
  the only required field? What does it return — the full detail card, the rollup
  entry, or just `{ key }`?
- `POST /projects/import` body: confirm `{ integrationKey, projectKey, dir?, info?, setUp? }`.
  Same question on the response shape.
- `PATCH /projects/:key` body `{ label?, dir?, info?, setup?, integrationKey? }`
  — does it echo the full detail card back?

## 4. suggest-dir
`GET /projects/suggest-dir?label=` — exact response field name for the path?
(`{ dir }` / `{ path }` / `{ suggestedDir }`?)

## 5. Integrations
- `GET /integrations` — array shape? Fields per integration (`key`, `label`, and
  what else — `kind`/`type`, `connected` bool, an icon/slug for rendering)?
- `GET /integrations/:key/projects` — array shape for the importable catalog?
  Fields per row (`projectKey`, `label`?, `suggestedDir`, `imported` bool, and
  anything needed to disable already-imported rows)?

## 6. Lifecycle → session records
- `POST /projects/:key/setup` and `/verify` return a session record (201). Is it
  the **same SessionRecord** shape as `GET /sessions/:id` (so we route it straight
  to the tail)? Any extra fields distinguishing a setup/verify session?

## 7. Error codes (we branch on `code`, never the English string)
Confirm the exact `code` string for each:
- delete a project that has a running session → 409, code = ? (`PROJECT_IN_USE`?)
- `DELETE /sessions/:id` while running → 409, code = ? (email said delete/cancel
  reuse `UNKNOWN_SESSION` / `SESSION_NOT_RUNNING`, but 409-on-delete-running
  wasn't named)
- `verify` before setup has run → 400, code = ?
- create/import validation failures → `BAD_REQUEST`, `PROJECT_EXISTS`,
  `UNKNOWN_INTEGRATION`? Anything else (bad dir, missing label)?

## 8. Optional-field presence
Which SessionRecord fields are optional on older peons (so we render "unknown"
not 0/empty)? Confirmed so far: `eventCount`, `agentAuth`. Any others?
