# Showing a file

Every file the web client displays is still named by `FileSource` in
`apps/web/src/features/projects/fileLinks.ts` and rendered by `FileView.tsx`. Public
browser and mobile routes are unchanged:

| Source | Overseer route |
| --- | --- |
| attachment | `GET .../peons/:id/attachments?path=` |
| project | `GET .../peons/:id/projects/:key/files/<path>` |
| project by stable ID | `GET .../peons/:id/projects/by-id/:projectId/files/<path>` |
| session artifact | `GET .../peons/:id/sessions/:sid/file[/raw]?path=` |

## One byte plane

Overseer authorizes the workspace, Peon, project/session and operator, then
streams the request through the direct authenticated Peon Fleet HTTP API over
mesh. This is the only authority for:

- sandbox and project file bodies, metadata and Range downloads;
- attachment and project uploads;
- project move/delete mutations;
- session artifact metadata, raw/download bytes, preview handoff and watch SSE.

There is no transfer WebSocket, transfer capability negotiation, socket
fallback or reverse-command byte payload. Browser abort closes the upstream
HTTP request. Node/HTTP stream backpressure bounds bytes in flight. Peon keeps
its existing path normalization, realpath containment, symlink defenses, size
limits, checksum validation, temporary-file cleanup and atomic commit.

Directory listings use the same Fleet HTTP plane. Overseer strips only its
private `directory=1` hint and preserves every other raw query parameter.
Peon self-update packages are not file traffic: Peon fetches them directly from
the public npm registry after an owner-authorized Fleet HTTP apply request.

## Attachment paths

Transcript attachments may contain absolute Peon paths while `/files/...` is
relative to `fileTransferRoot`. `/attachments?path=` therefore resolves the
absolute path against the Peon's configured sandbox before proxying it. It
returns stable `PATH_ESCAPE` and `FILES_DISABLED` errors without exposing the
filesystem root.

## Display policy

Project/preview responses retain isolation headers, Range/Content-Range,
Content-Disposition, ETag and Last-Modified semantics from the Peon response.
The viewer keeps its existing type inference and size limits.
