# AI statistics

The owner-only Peon Stats tab shows recorded AI usage, provider quota, and
capabilities. Compact layouts stack provider cards vertically.

## Data sources

The feature uses the workspace-scoped peon routes:

- `GET /api/workspaces/:workspaceId/peons/:peonId/stats?period=...`
- `GET /api/workspaces/:workspaceId/peons/:peonId/analytics?period=...&groupBy=user|project`
- `GET /api/workspaces/:workspaceId/peons/:peonId/quota/:provider`
- `GET /api/workspaces/:workspaceId/peons/:peonId/capabilities/:provider`

Supported periods are `day`, `yesterday`, `week`, and `month`. Supported
provider identifiers are `claude-code` and `codex`.

Stats load before recorded model usage is assigned to provider cards. Quota and
capability requests then succeed or fail independently. Refreshing a provider
adds `refresh=1` to both probes.

## Presentation rules

- Headline session count, output tokens, and duration.
- Show the complete persisted session-state size separately from the selected
  period because `sessionsSizeBytes` covers the whole store.
- Show prompt and token breakdowns by transcript-turn author and project,
  ordered by output tokens for the selected period.
- Keep input, cache creation, and cache read as a secondary breakdown.
- Never headline `totalTokens`: it already includes cache tokens and cache read
  can make the number look like newly generated work.
- Group recorded model usage under its canonical provider.
- Show account quota windows and reset countdowns when supplied.
- Keep Plugins, Skills, and MCP inventories collapsed until requested.
- Treat a 404 from `/stats` as an unsupported Peon version.
- Explain that prompt counts use each persisted user turn's author. Unsigned
  historical turns fall back to the session initiator. Tokens, duration,
  outcomes, and storage remain session-level and are repeated for every
  participating author because Peon has no exact per-message usage.

## Caching and privacy

The last successful stats payload is cached in Drift by workspace, peon, and
period. Cached totals render first and remain available while the peon is
offline; an online refresh replaces the matching cached payload.

Provider quota, account email, and capability inventory are not persisted.
They are operational and potentially sensitive, so they are loaded only while
the peon is online.

## Validation

Focused tests cover the flat stats contract, cache round-tripping, provider
route scoping, period changes, totals, quota, capabilities, and
offline behavior. UI changes must also be checked on a real device with the
`dev` flavor.
