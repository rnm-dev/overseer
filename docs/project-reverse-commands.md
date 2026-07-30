# Project reverse commands

Project administration and on-demand project resources use the shared
`reverse-command-v1` lifecycle. They do not introduce another command ledger,
status frame, acknowledgement, or retry dialect.

After project creation, commands identify a project only by immutable
`target.projectId`. Settings updates, deletion, and quick-link mutations carry
the canonical project digest in `expected.digest`; stale digests return
`conflict/PROJECT_CONFLICT`. Overseer derives the actor from the authenticated
user record, authorizes the workspace, Peon, project and operation before
admission, and never accepts a browser-provided actor.

Every terminal result is checked against an operation-specific status, code and
field allowlist before it can enter the reverse-command transaction. Project
IDs in results must match the admitted target. Extra fields, messages,
credential-like additions, oversized details and contradictory tuples fail
closed. The existing transaction generation-fences the result, commits the
terminal command, inbox cursor, audit and browser event, then permits the
durable acknowledgement. Project mutations continue to publish their
authoritative state through `project-catalog-v1`; command results are not a
second project projection.

## Documentation index pagination

`project.documentation.index` serializes one bounded documentation snapshot
(maximum 2 MiB) and returns UTF-8-safe pages of at most 32 KiB:

```json
{
  "snapshotDigest": "<sha256>",
  "byteOffset": 0,
  "totalBytes": 48123,
  "chunk": "{\"exists\":true,...",
  "cursor": "<opaque current-page cursor>",
  "nextCursor": "<opaque continuation or null>"
}
```

The first request carries `{ "limit": 32768 }`; later requests add the returned
`cursor`. A cursor binds its byte offset to the SHA-256 identity of the complete
snapshot. Malformed cursors return `rejected/INVALID_CURSOR`; if the
documentation changes between pages, the old cursor returns
`conflict/CURSOR_EXPIRED`. Replaying the same command ID/body is handled by the
shared durable dedupe ledger and returns the recorded page.

Overseer aggregates at most 2 MiB and 96 pages, requires contiguous offsets and
one digest/total across the sequence, parses the completed JSON, and recursively
allowlists the documentation tree before returning the legacy HTTP shape. That
last step is a real conversion, not a pass-through: the snapshot Peon returns is
`{ exists, indexPath, index, tree }`, while the public contract of
`GET .../projects/:projectId/docs` is the flat `docs/` listing
`{ exists, entries: [{ name, type, size, mtimeMs }] }` that both the web
dashboard and the Flutter client read. The snapshot's top-level `tree` *is* that
directory, so `projectDocsFromSnapshot` flattens it — nested children stay behind
their directory entry — and no client learns a second shape for one route. Once
the reverse operation is selected, a disconnect or page failure never retries
through Peon's legacy HTTP route. Older Peons that did not negotiate the exact
operation retain the exclusive legacy path.
