# Session orchestration MCP

Peon root sessions can delegate independent work to child sessions through the
loopback-only `/mcp/sessions` server. This is an application-service wrapper
around the same session start operation used by the human and fleet transports.

## Tools

- `list_session_options` returns the live project, agent, model, and reasoning-effort
  catalogs plus the recursion-depth policy.
- `spawn_sessions` starts one or more children without a count cap. Every item supplies a parent-scoped
  `requestId`, self-contained prompt, project key, agent, and optional model, effort, and short
  display `name`. The name is persisted as the session title and participates in idempotency.
- `get_child_sessions` returns compact status records for direct children, including an
  optional name and an outcome when the target session has one.
- `wait_for_child_sessions` waits at most 30 seconds for selected direct children and
  returns the same compact records. It does not place transcripts into the parent context.
- `get_child_transcript` reads a newest-to-older page for one direct child. Pages default
  to 10 events and are capped at 20. The serialized response defaults to and cannot go
  below 12,000 characters, and has a hard maximum of 30,000. Oversized events become
  typed truncated previews, or metadata-only markers when required to honor the total
  budget; opaque `nextCursor` values fetch older pages.
- `send_session_followup` sends a follow-up to any existing Peon session. The target does
  not need to be a child or belong to the same project, and the caller may target itself.
  Optional model and reasoning-effort selections are validated against the target's agent.
  An optional `requestId` is recorded as a correlation ID on the target user-message event.

Every child is started as a normal chat session with `expectsOutcome: false`. It independently
receives the selected project's working directory, normal Peon system prompt, and injected
`docs/index.md`. Its final response is persisted as ordinary assistant text rather than being
replaced by a structured outcome. The parent reads that text with `get_child_transcript`;
`get_child_sessions` and `wait_for_child_sessions` still report completion from the child
status. The parent's transcript is deliberately not copied; delegated prompts must be
self-contained.

When an automated child finishes its last queued turn, Peon appends a durable hidden system
trigger to the parent. It never interrupts a running parent turn. All triggers accumulated
during that turn are coalesced and injected as system instructions into the next queued user
turn. If no user message is waiting, Peon starts one hidden automation turn after the current
turn. Hidden triggers do not appear as queue items, transcript user messages, session API
fields, or change-stream payloads. Each trigger identifies the child and instructs the parent
to read its assistant response through `get_child_transcript`. Each orchestration-initiated turn
(the initial spawn or a `send_session_followup` turn) earns exactly one completion handoff,
including when other child work is already queued. Manually initiated child turns do not notify
the parent and cannot inherit notification debt from a preceding automated turn. The pending-turn
marker and completion timestamp make duplicate completion delivery harmless without suppressing
later automated follow-ups.

## Token and recursion safety

The recursion controls are daemon-enforced and cannot be relaxed by an agent prompt:

- spawn batches and retained direct-child sets have no count cap;
- maximum delegation depth is one;
- spawned children do not receive the `peon_sessions` MCP binding;
- the orchestration service rejects a child session even if it reaches the route directly;
- child system prompts explicitly prohibit starting sessions through shell or HTTP APIs;
- each root receives a signed session-bound MCP capability;
- `requestId` is persisted on the child and makes exact retries idempotent;
- reusing a `requestId` with different parameters is rejected before starting new work.
- transcript reads reject unrelated session IDs, enforce session-bound cursors, and have
  hard event and serialized-character limits.

These controls prevent accidental recursive fan-out. The capability is not intended to isolate
mutually hostile processes running as the same operating-system user: such processes can already
read one another's files and control the local workspace.

Follow-ups deliberately have no per-session, per-caller, or aggregate count cap. Sending one to
a running session uses the normal Peon follow-up behavior: a steer-capable provider may accept it
inside the active turn, while other cases interrupt and resume the target. This broad authority is
available only to root sessions carrying their signed session MCP capability. It does not change
the one-level child-spawning limit.

## Persisted lineage

New session summaries carry:

- `parentSessionId`: direct parent or `null` for a root;
- `spawnDepth`: zero for roots and one for MCP-created children;
- `spawnRequestId`: parent-scoped idempotency key or `null`.
- `parentCompletionNotifiedAt`: internal timestamp of the most recently delivered automatic
  parent handoff, or `null`;
- `parentCompletionNotificationPending`: internal durable marker indicating that the current
  child turn was orchestration-initiated and still owes one parent handoff.

Restart recovery initializes these fields for legacy summaries. Lineage therefore survives daemon
restarts and continues to enforce delegation depth. Hidden completion triggers are resumed after
restart reconciliation even when ordinary interrupted-session auto-resume is disabled.
