# Codex app-server rollout

Peon supports two distinct persisted Codex agent IDs during the rollout:

- `codex-app-server` — the persistent native thread/turn runtime.
- `codex` — the legacy `codex exec --json` compatibility fallback.

Choose either driver explicitly in the new-session composer, or set `defaultAgent`
in Settings for requests that omit `agent`. Existing sessions always retain their
persisted agent ID; changing the default never migrates or silently falls back a
conversation.

The app-server driver requires Codex CLI 0.144.0 or newer. Its current state is
available from `GET /api/v1/ai/status/codex-app-server` and the dashboard AI page.
`incompatible` and `failed` states include an actionable runtime error. `stopped`
means no app-server-backed session has started the process yet.

To fall back, select **Codex (Legacy exec)** for a new session or restore it as the
default. Do not rewrite `agent` in persisted session summaries: native thread IDs
and legacy exec conversation state are not interchangeable.

Keep the legacy driver available until app-server new sessions, follow-ups,
steering, queues, cancellation, timeout, structured output, attachments, MCP,
previews, restart recovery, concurrent sessions, SSE, analytics, and durable
summaries have passed QA in the target environment.
