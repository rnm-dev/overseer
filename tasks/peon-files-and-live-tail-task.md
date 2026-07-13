# Peon task: project file browsing and reliable live session tails

## Context

Overseer currently has two user-visible failures that require Peon-side work:

1. Opening a project cannot list or view its files.
2. A running session can remain on **Thinking** without showing new output until
   the operator refreshes the page.

The Overseer proxy and UI already support both features. Keep existing API
behavior backward compatible and implement the missing/reliability work in Peon.

## 1. Expose project files through the machine API

The existing project-files handler is not usable with Peon's standard machine
credential. Across all connected Peons, this currently reproduces as:

```text
GET /api/v1/projects                         -> 200
GET /api/v1/projects/<key>/files?stat=1      -> 401 {"error":"not authenticated"}
GET /api/v1/projects/<key>/files/?stat=1     -> 401 {"error":"not authenticated"}
```

Implement the following read-only routes under the same Bearer-token middleware
used by the rest of `/api/v1`:

```http
GET /api/v1/projects/:key/files/{*path}?stat=1
GET /api/v1/projects/:key/files/{*path}
```

Both `/files` and `/files/` must address the project root.

### Directory and metadata response

With `?stat=1`, return JSON:

```json
{
  "path": "src",
  "entries": [
    { "name": "components", "type": "dir", "mtimeMs": 1700000000000 },
    { "name": "main.ts", "type": "file", "size": 1234, "mtimeMs": 1700000000000 }
  ]
}
```

For a file, return metadata with `path`, `type: "file"`, `size`, `mtimeMs`, and
optionally `sha256`.

Without `?stat=1`, stream the file body and set an appropriate `Content-Type`.
Support `Range` requests and return `206`, `Content-Range`, and `Accept-Ranges`
when applicable.

### Security requirements

- Resolve paths relative to the selected project's configured `dir`.
- Canonicalize the project root and requested path before access.
- Reject `..`, symlink, and encoding-based escapes outside the project root.
- Keep these routes read-only; do not add PUT, PATCH, or DELETE.
- Use the standard `/api/v1` Bearer credential and honor `Peon-Actor`.
- Do not expose files from another project or from `fileTransferRoot` implicitly.

### Stable errors

Return JSON errors with these codes:

- `404 UNKNOWN_PROJECT` — project key does not exist.
- `404 NOT_FOUND` — requested path does not exist.
- `400 PATH_ESCAPE` — requested/canonical path leaves the project root.
- `403 FORBIDDEN` — path is intentionally excluded by policy, if applicable.

Do not use `401` for a valid Overseer credential.

## 2. Make session SSE tails reliable

Overseer subscribes to:

```http
GET /api/v1/sessions/:id/stream
Authorization: Bearer <overseer credential>
Peon-Protocol: 1
```

The connection can currently remain open without delivering newly appended
session events. Refreshing works because `/transcript` contains the missing
events. Fix the Peon stream so every committed transcript event is emitted to
all current subscribers promptly.

### Required behavior

- Authenticate and validate the session before starting the stream.
- Send response headers immediately; do not wait for the first event.
- Use `Content-Type: text/event-stream`, `Cache-Control: no-cache`, and flush
  headers where the runtime requires it.
- Subscribe the client before taking the replay/high-water snapshot so events
  cannot fall into a replay-to-live race window.
- Emit each committed transcript event as a complete SSE frame:

  ```text
  event: event
  data: {"type":"assistant",...}

  ```

- End every frame with a blank line (`\n\n`; CRLF is also accepted).
- Split multiline payloads into multiple `data:` lines, or serialize JSON onto
  one line.
- Send an SSE comment heartbeat (for example `: ping\n\n`) at least every 15
  seconds so half-open connections are detected by proxies and clients.
- Remove listeners and timers immediately when the request aborts/closes.
- Preserve event order and do not deliver an event more than once on one
  uninterrupted connection.
- A newly connected stream must replay enough existing events to close the gap
  between the caller's transcript snapshot and live subscription. If Peon has an
  event cursor, support `Last-Event-ID`; otherwise use an atomic
  subscribe-then-snapshot handoff.
- Return stable JSON errors before SSE headers for unknown sessions and failed
  authentication.

## Acceptance tests

### Project files

- A valid Overseer Bearer credential can list a project root using both
  `/files?stat=1` and `/files/?stat=1`.
- Nested directories can be listed and text/image files can be downloaded.
- Spaces, Unicode, and URL-encoded path segments work.
- `Range: bytes=0-99` returns exactly 100 bytes with status `206`.
- Unknown projects and missing paths return the specified stable codes.
- `../`, encoded traversal, absolute paths, and symlinks leaving the project root
  return `PATH_ESCAPE` and never disclose external metadata or content.
- Mutation methods on project-file routes return `404` or `405`.

### Live tails

- Connect a stream, start/follow up a session, and verify each new transcript
  event arrives without another HTTP request or page refresh.
- Connect while events are being appended and prove there is no event gap at the
  replay/live boundary.
- Keep a session quiet for over 30 seconds and verify heartbeat frames arrive;
  then append an event and verify it is delivered on the same connection.
- Disconnect and verify the Peon has no leaked subscriber or heartbeat timer.
- Run two simultaneous subscribers and verify both receive ordered events.
- Restart/reconnect and verify resume/replay delivers missed events once.

## Definition of done

- All acceptance tests are automated in the Peon repository.
- The observed project-files requests return `200` instead of `401` with the
  credential already used successfully by `/api/v1/projects`.
- During a real session, Overseer displays incremental output and leaves
  **Thinking** when the result event arrives, without a browser refresh.
- Peon's API/protocol documentation describes the new project-file routes and
  session stream replay/heartbeat behavior.
