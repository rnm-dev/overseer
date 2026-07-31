# Codex app-server

Peon runs Codex sessions through the persistent native `codex-app-server`
thread/turn runtime. The former `codex exec --json` driver was removed after the
rollout completed.

The app-server driver requires Codex CLI 0.144.0 or newer. Its current state is
available from `GET /api/v1/ai/status/codex-app-server` and Overseer.
`incompatible` and `failed` states include an actionable runtime error. `stopped`
means no app-server-backed session has started the process yet.

Historical sessions persisted with `agent: "codex"` remain readable through the
canonical transcript compatibility boundary, but they are retired and cannot
accept follow-ups. Do not rewrite their persisted agent ID: native app-server
thread IDs and legacy exec conversation state are not interchangeable.
