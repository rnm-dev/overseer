# Reverse runtime capabilities

OVSR-137 replaces callback reads for routine runtime state and expensive
provider/analytics reads with two versioned reverse capabilities.

## `runtime-state-v1`

The Peon publishes one complete, replaceable `runtime_state` document through
the shared durable outbox. It has an independent process epoch, monotonic
revision and SHA-256 digest. A new process epoch is authoritative after a
restart or update. Unsent state may be coalesced under the `runtime-state`
coalesce key; an already assigned durable cursor is immutable.

The projection contains only paused state and active/total capacity, daemon
version/revision, provider availability and public capabilities, supported
models/reasoning modes, and freshness metadata. It excludes paths, environment,
credentials, provider authentication replies and unrestricted metrics.
Overseer commits state and the shared durable inbox cursor together before
acknowledging it. Reads report `fresh`, `stale`, or `offline`.

## Bounded runtime queries

Provider quota/capabilities, fixed-period stats, and filtered analytics use
operations on `reverse-command-v1`; there is no runtime-specific request
ledger:

- `runtime.quota` — `{ provider, refresh }`
- `runtime.capabilities` — `{ provider, refresh }`
- `runtime.stats` — `{ period }`
- `runtime.analytics` — `{ query }`

The shared substrate supplies actor derivation, admission, deduplication,
timeouts, reconnect reconciliation and durable terminal results. Requests and
results stay under its frame bound; malformed filters and oversized results are
rejected with stable safe codes. A negotiated reverse generation selects this
route exclusively, while legacy Peons continue using HTTP callbacks.

Status and models are projected because they are cheap and needed fleet-wide.
Quota and analytics remain on demand because they are slower, volatile, and
potentially account-sensitive.
