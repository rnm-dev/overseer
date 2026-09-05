# Agent model catalog discovery

Peon treats the installed agent CLI as the primary authority for selectable
models and model-specific reasoning efforts. The `AgentDriver` owns the
provider protocol through `services.modelCatalog`; the provider-neutral model
catalog owns caching, validation, defaults and API projection.

## Provider discovery

- Codex uses the already supervised app-server runtime and paginates
  `model/list`. Peon keeps the CLI's visible model order, display names,
  `isDefault`, `model` wire ID, `supportedReasoningEfforts`, and
  `defaultReasoningEffort`.
- Claude Code starts a short-lived, non-interactive safe-mode process and sends
  the Agent SDK `initialize` control request over stream-json. Its `models`
  response supplies the CLI-selectable alias, resolved model ID, display name,
  and supported effort levels. Discovery never submits a user prompt and never
  starts model inference.

Claude's `default` pseudo-row is not exposed as a second selectable model. Its
`resolvedModel` marks the matching concrete row as the provider default. The
CLI-facing `value` is retained as that model's alias, while the resolved ID is
the canonical session value. An effort list may have no marked default when the
CLI does not publish one; `null` then deliberately lets the provider choose.

## Cache and fallback

Discovery runs before the daemon accepts sessions. Successful catalogs are
cached in memory for five minutes; a lightweight background poll checks once a
minute and refreshes only when that TTL expires. Failures retry after thirty
seconds and do not stop Peon startup:

- before any successful discovery, the driver-bundled catalog is the fallback;
- after a successful discovery, a transient refresh failure retains the last
  known CLI catalog instead of replacing it with guessed data.

Each provider returned by `GET /api/v1/models` carries `catalogSource`
(`cli`, `stale-cli`, or `fallback`), `catalogUpdatedAt`, and `catalogError`.
`?refresh=1` forces both drivers to refresh before the response. Ordinary
session and settings validation is synchronous and uses the latest successful
catalog, so an advertised model/effort pair is also the pair Peon accepts.

Static models are intentionally a compatibility floor, not a release feed.
Adding a provider requires a driver-owned discovery service or an explicit
decision to remain on fallback; provider-specific parsing does not belong in
the HTTP routes or clients.
