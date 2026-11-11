# Session sign-offs

Status: design settled in OVSR-609. The Peon side is built in OVSR-610 (see
[What Peon implements](#what-peon-implements) below). The Overseer server,
projection consumer, decision permissions and web UI are not built yet.

A Peon session started by an external event (see
[source-triggered workflows](armory-workflows.md)) works on its own. Some
steps, by the project's instructions, need a person's decision first. The agent
does not wait for it: it records a sign-off, ends its turn, and the decision
reaches the same session later as a follow-up. The model is adapted from
Heroboard's sign-offs; this page is self-contained, so nothing from that
repository is needed to build it.

## Decisions taken

- **Non-blocking.** The agent never holds a turn open for a person. A turn that
  waited would hold resources for hours and would not survive a Peon restart.
  Short in-turn confirmations such as
  [managed plugin inquiries](managed-plugin-inquiries.md) are a separate thing
  and stay as they are.
- **Stored on the Peon, beside its session.** A sign-off belongs to one
  session, and sessions are Peon's authority, so the record lives there too and
  survives without Overseer. Overseer keeps a read projection (like
  [session catalog synchronization](session-list-sync.md)) for the sidebar tab,
  badges and pushes across the fleet. Operators, permissions and the decision UI
  stay in Overseer, and decisions travel to Peon over Fleet HTTP. The cost:
  while a Peon is offline its sign-offs can be seen from the projection but
  cannot be decided.
- **Only sessions started by a trigger can propose.** When a person is chatting
  with the agent, the agent asks them directly. Peon exposes `signoff_propose`
  only to sessions whose origin is a trigger (a workflow or automation call),
  never to sessions a person started. A person following up later on a
  triggered session does not change its origin. The tools for an existing
  sign-off (`signoff_revise`, `signoff_answer`, `signoff_withdraw`) stay
  available so that the agent can respond to a decision.
- **Actions are mostly free-form.** An option describes what the agent will do
  in plain words, with exact text wherever something goes outward (a reply, a
  message, a value). The agent carries it out itself after the decision. Typed
  actions that the Peon runs mechanically may come later for specific tools;
  the record has room for them (`type` on an action), but nothing depends on
  them.

## Model

A head plus an append-only history:

```
signoff head            — lists, badges, links
  id, projectKey, number                    SO-12 within the project
  sessionId                                 the session that proposed it
  source                                    the trigger's { id, source, correlationId }, if any
  headSeq, status, assigneeIds[]            projections of the events
  orphaned                                  the session was deleted
  createdAt, updatedAt

signoff events          — append-only
  seq
  author                                    agent (session id) · operator (id) · policy · peon
  kind, baseSeq
  snapshot                                  on events that change content
  message                                   a person's input, a reason, the agent's note
  optionId                                  on approved
  assigneeIds                               on reassigned
  results                                   on executed and interrupted
  requestId                                 on operator events, for idempotency
  createdAt
```

Snapshot: `title`, `summary`, `options[]` (`{ id, label, recommended?,
rationale?, actions[] }`, each action `{ id, summary, detail?, type:
"freeform" }`), `assignees`, and `context` — short excerpts from the triggering
event, never whole payloads.

### Events

| Kind | Author | Meaning | Status after |
| --- | --- | --- | --- |
| `proposed` | agent | first snapshot | pending |
| `revised` | agent | new snapshot; message says what changed and why | pending |
| `answered` | agent | reply to a comment, snapshot unchanged | pending |
| `commented` | operator | a correction, question or instruction | changes requested |
| `approved` | operator / policy | chooses `optionId`, against `baseSeq` | approved |
| `rejected` | operator | the whole sign-off, optional reason | rejected |
| `reassigned` | operator / agent | who decides | unchanged |
| `withdrawn` | agent / operator | obsolete or handled elsewhere | withdrawn |
| `superseded` | agent | merged into another sign-off (link) | superseded |
| `executing` | agent | lock before acting, bound to the approved `baseSeq` | executing |
| `executed` | agent | per-action results | done · partly done · failed |
| `interrupted` | peon | an `executing` that never got its `executed` | interrupted |

An `executing` without `executed` after a restart or a failed session ends as
interrupted. The current state is the snapshot of the latest event that carries
one; the head can be rebuilt from the events.

Rules: one sign-off per topic, many actions inside. A person chooses one option
or rejects the whole sign-off; "this, but without X" is a comment, and the
agent revises. Every option is a plan the agent would defend: no filler and no
"do nothing" option, since rejecting is always possible. A decision against a
`baseSeq` that is no longer the head is refused ("SO-12 changed, take another
look"); of two concurrent decisions, the second gets the same refusal. While
executing, nothing can revise, withdraw or decide. After executed nothing is
edited, and a correction becomes a new sign-off linking to the old one. Nothing
rejected or executed is proposed again unless something new happened.

## The loop

1. **Propose.** The agent calls the MCP tool `signoff_propose` (with
   `signoff_list`, `signoff_get`, `signoff_revise`, `signoff_answer`,
   `signoff_withdraw` beside it), then does everything else it can do without
   the decision and ends its turn. Peon writes the record itself, stamping the
   session, project and source, and publishes it to Overseer's projection. The
   session settles as awaiting sign-off, a state of its own, not a failure.
2. **Decide.** A person approves an option, rejects, or comments, in Overseer
   only. Overseer checks the operator's permissions and forwards the event to
   the Peon, which checks `baseSeq` and refuses a stale decision. Who may
   decide: the assignees, or project administrators and workspace owners when
   nobody is named.
3. **Deliver.** Peon puts the accepted decision into the same session as a
   follow-up through the existing queue (see
   [sessions and turns](sessions-and-turns.md)). The follow-up carries the
   approved option's text as it stood at `baseSeq`. That frozen text is the
   instruction; the agent does not reread a newer version. A comment is
   delivered the same way and gets an `answered` or `revised` in reply. If the
   session is busy, the decision waits in the queue. If the Peon is offline,
   the decision is refused; nothing is queued in Overseer.
4. **Execute.** The agent records `executing`, does the work, and records
   `executed` with a result per action. Because actions are free-form, results
   are reported by the agent, and the card says so. Peon guarantees what was
   approved and delivered, not what the model did with it. An `executing` left
   without `executed` (session failed, Peon restarted) is closed as
   interrupted, with every action marked "check whether it happened".
5. **Close the loop.** For a triggered session, the sign-off's status and the
   final outcome go back to the source system through the workflow API, with
   the same correlation id.

## Decided after review

- A sign-off always belongs to its session. It is visible in the session itself
  as well as in the list. If the session has been deleted or archived when a
  decision arrives, delivery fails with an error and the sign-off stays
  visible; no new session is started in its place.
- Policies are written in Russian, as plain-language rules (the `policy` author
  is reserved in the model). How a policy is checked is not designed yet.
- Web UI: a new Sign-offs tab in the sidebar, listing what is waiting on the
  viewer. Which push signal it uses is still open (see
  [push notifications](push-notifications.md)).
- No reminders and no sweep. A sign-off waits until someone decides it.

## What Peon implements

Wire shapes are normative in
[`session-signoffs-v1`](protocol/session-signoffs-v1/schema.json), with golden
fixtures beside it. Peon advertises `session-signoffs-v1` in `GET /status`
capabilities. Code lives in `apps/peon/src/daemon/signoffs/`.

### Session origin

- `POST /api/v1/sessions` accepts `origin: "operator" | "trigger"` and, with
  `trigger`, an optional `trigger: { id, source, correlationId }` (each a
  string of at most 200 characters, or null). The origin is explicit because an
  automation-API session is authored like a person's. Absent means `operator`.
- The session record stores `origin` and `trigger` once, at creation. Follow-ups
  never change them. Legacy records without the field read as `operator`. A
  branch is a person's act, so a branched session is `operator`.
- The session record and every `session-catalog-v1` row expose `origin`,
  `trigger` and `settledState`. `settledState` is `"awaiting_signoff"` while
  the session is completed and at least one of its sign-offs is `pending`, and
  `null` otherwise. It is cleared when a turn starts and recomputed when a
  turn settles and after each operator decision.
- A trigger-origin session's system prompt tells the agent that nobody watches
  the chat and how to use sign-offs.

### Storage

- One JSON file per sign-off in `<stateDir>/signoffs/<id>.json` (`{ version: 1,
  head, events }`), written with temp file plus rename, as session summaries
  are. They live outside the session directory so that deleting a session
  keeps them; the session's deletion marks them `orphaned`. There is no
  retention sweep, matching sessions.
- Append-only is enforced by the store: the only mutation is appending the next
  seq, stored events are deep-frozen, and the only head change outside the log
  is the `orphaned` flag. On load the head is rebuilt from the events, so a
  hand-edited head is ignored.
- Numbers are `max + 1` within the project key on this Peon (sessions without a
  project share one sequence).
- Limits: 1–6 options, 1–10 actions per option, ids `[A-Za-z0-9._-]{1,64}`
  unique within their scope, title 200, summary 4000, label 200, rationale
  2000, action summary 500, action detail 8000, up to 5 context excerpts of
  1000, up to 10 assignees of 200, message 8000, result note 2000 characters,
  and 64 KiB for the serialized snapshot.

### MCP tools

The `peon_signoffs` binding is in every session's MCP config, authenticated
with the same signed session capability as `peon_plugins`.

- `signoff_propose` is listed only for a trigger-origin session; a direct call
  from any other session is refused with `SIGNOFF_NOT_ALLOWED` ("ask them
  directly").
- `signoff_list`, `signoff_get`, `signoff_revise`, `signoff_answer`,
  `signoff_withdraw` (with `supersededBy` it records `superseded`) work in any
  session, only on that session's sign-offs.
- `signoff_executing` and `signoff_executed` take the `baseSeq` the approval
  was made against. `executed` needs one result (`done`, `failed`, `skipped`)
  for every action of the option as approved.
- Enforced in code: no revise or withdraw while executing; nothing after a
  terminal status; `executed` only after `executing`; revising an approved
  sign-off returns it to pending and voids the approval.

### Decision intake

- `POST /api/v1/signoffs/:id/events` with `{ requestId, kind, baseSeq,
  optionId?, message?, assigneeIds?, operatorId? }`. `kind` is `commented`,
  `approved`, `rejected`, `reassigned` or `withdrawn`; the operator is
  `operatorId` or else the forwarded `Peon-Actor`.
- `baseSeq` must equal the current `headSeq`, otherwise `409 SIGNOFF_CHANGED`.
  Writes are synchronous, so of two concurrent decisions exactly one wins.
  A repeated `requestId` returns the current view with `replayed: true`
  (`200`); reusing it for another kind is `409 IDEMPOTENCY_CONFLICT`.
- Approve, comment and reject need `pending` or `changes_requested`;
  reassign and withdraw work on any open, non-executing sign-off. Otherwise
  `409 SIGNOFF_STATE`.
- If the session is gone the sign-off is marked orphaned and every decision but
  `withdrawn` is refused with `410 SIGNOFF_SESSION_GONE`. Peon has no archive,
  so deletion is the only case.
- An accepted `approved` or `commented` is enqueued into the session's durable
  queue with `commandId` `signoff:<id>:<seq>` and the operator as author. The
  approval text is rebuilt from the snapshot at `baseSeq`. It runs at once if
  the session is idle, waits if it is busy, and survives a restart like any
  queued follow-up.
- Reads: `GET /api/v1/signoffs?status=a,b&projectKey=&sessionId=` and
  `GET /api/v1/signoffs/:id` (summary, current snapshot, full history).

### Projection

`signoff-catalog-v1` is a reverse-socket channel built like
`session-catalog-v1` (see [resource synchronization](resource-synchronization.md)):
per-restart epoch, revision and seq journal, paged snapshots fenced by a
barrier seq, frames `signoff_catalog_event` and
`signoff_catalog_snapshot_page`. Rows are sign-off summaries (the head plus
`displayNumber` and `title`). There are no tombstones; sign-offs are never
deleted. Overseer has to accept the capability before frames flow.

### Recovery

On boot sign-offs are loaded before sessions are restored; every `executing`
gets an `interrupted` event with each action's result `unknown`, "check whether
it happened". When a turn settles, an `executing` it left open is interrupted
the same way. After sessions are restored, sign-offs of missing sessions are
marked orphaned.
