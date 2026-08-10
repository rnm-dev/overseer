# Unified resource synchronization

Catalog-like resources share one synchronization model without sharing an
authority they do not have. Domain adapters define identity, validation and
storage; the common core defines monotonic application, snapshot barriers,
generation/cursor fences, freshness, bounds and payload-free measurements.

## Authority matrix

| Family | Authority | Explicit reads and writes | Realtime projection |
| --- | --- | --- | --- |
| sessions | Peon | Fleet HTTP over mesh | `session-catalog-v1` |
| projects | Peon | Fleet HTTP over mesh | `project-catalog-v1` |
| Peon/runtime | Peon | Fleet HTTP over mesh | heartbeat and `runtime-state-v1` |
| workspaces | Overseer | Overseer HTTP/database | workspace events |

This matrix is normative. Reuse never turns a projection into request
authority and never makes a workspace Peon-owned. Transcript history/tails,
file byte streams and durable commands keep their specialized protocols.

## Shared state machine

Every adapter supplies a qualified identity, monotonic version, authority and
payload parser. The shared lifecycle is:

1. enter `syncing`, claim a connection generation and resume a committed
   cursor/frontier when compatible;
2. otherwise build one bounded snapshot behind a stable epoch/revision/barrier;
3. atomically replace the projection and checkpoint, then acknowledge;
4. apply live upserts/tombstones only when their generation, cursor and version
   are current, committing visible state and cursor before ACK;
5. enter `stale` on a gap or rebuild requirement and `offline` on transport
   loss, retaining the last authoritative rows.

The server's `CatalogSnapshot<T>` is now the single paged snapshot/barrier and
pressure implementation used by session and project catalogs. Runtime state is
a bounded singleton projection on the same durable delivery frontier. Browser
session and project lists share `mergeResourceProjection`; Flutter session and
project repositories share `ResourceProjectionEnvelope` and advance their
workspace cursor in the same database transaction as the domain write.
Flutter fleet refreshes validate workspace and Peon inventory through the same
bounded, duplicate-safe `ResourceSnapshot` before atomically replacing their
cache; workspaces remain Overseer-authoritative.

## Compatibility and verification

Released wire names and payloads do not change. Mixed versions therefore keep
the existing capability negotiation and Fleet HTTP fallback rules. The shared
acceptance fixture is
`packages/protocol-conformance/fixtures/resource-sync-acceptance-v1.json`.
It executes sessions, projects, Peon/runtime state and workspaces through one
authority-neutral convergence harness, including stale generations, monotonic
versions, gaps, bounds and crash-before-commit. Domain suites remain responsible
for schema, ACL, persistence and wire compatibility.

Diagnostics use fixed resource/stage/outcome labels and bounded durations or
counts. Titles, prompts, previews, transcript content, paths, credentials and
raw payloads are forbidden.
