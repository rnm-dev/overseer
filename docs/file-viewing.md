# Showing a file

Every file the web client displays — a message attachment, a project file, a
documentation page, a session artifact — is named by one `FileSource` and read
through one reader. The rule for which route answers for which file lives in
`apps/web/src/pages/peon/fileLinks.ts`, and the fetch, the size caps, the type
decision and the failure text live in `apps/web/src/pages/peon/FileView.tsx`. A
surface contributes chrome only: a modal (`ProjectFilePreviewModal`), a side
pane (`ProjectFileBrowser`), a dialog (`AttachmentPreview`).

## The sources

| Source | Route | Used by |
| --- | --- | --- |
| `attachment` | `GET .../peons/:id/attachments?path=` | message attachments |
| `project` | `GET .../peons/:id/projects/:key/files/<path>` | project file tree, session file pane |
| `projectById` | `GET .../peons/:id/projects/by-id/:projectId/files/<path>` | project documentation |
| `sessionFile` | `GET .../peons/:id/sessions/:sid/file[/raw]?path=` | session artifact preview |

Uploads use `attachmentUploadPath` from the same module (`PUT
.../peons/:id/files/uploads/<folder>/<name>`), so a write and the read that
follows it cannot drift apart.

## Why attachments have their own route

The Peon's file transfer API is rooted at `fileTransferRoot`, so every path
under `/files/...` is relative to that sandbox. A transcript, however, carries
the *absolute* path the agent reads (`AttachmentInfo.path`) — which is all a
client ever has, because no surface renders a message before Peon commits it, so
the relative upload path never survives into a rendered row. Joining that absolute
path onto `/files/` produced `/files//tmp/peon-files/...`, which the Peon
resolved inside the root a second time and answered `404`; the symptom was that
attachments from other participants never opened.

`GET .../attachments?path=` accepts either form and Overseer maps it back
(`src/peonFileSandbox.ts`): it reads the Peon's `fileTransferRoot` (cached for
30 s per Peon), strips the prefix and proxies the sandbox-relative path. The
path travels as a query parameter deliberately — nginx merges the `//` in a
path by default, so a leading empty segment does not survive the proxies in
front of Overseer. The `/files/{*rest}` route still resolves an absolute path
when the double slash does reach it, which keeps an older mobile build working.

Refusals name themselves rather than surfacing as a bare status: `400
PATH_ESCAPE` when the file is outside the sandbox (a Peon-dashboard upload under
`~/.peon/sessions/<id>/attachments` is, and is unreachable this way), `503
FILES_DISABLED` when the Peon has no file transfer root, and the proxy's own
`502` codes when the Peon cannot be reached. The viewer shows that sentence.

## Which channel carries a file

The Peon's HTTP API is being retired: file traffic belongs on the Peon's reverse
transfer socket (`/api/v1/peons/transfer/ws`, channel `file-transfer`), which is
also the only path that works for a Peon Overseer cannot reach inbound. The
migration is partly done, and the split today is:

| Traffic | Channel | What it needs to move |
| --- | --- | --- |
| Project file read by ID (docs, web preview) | socket, `project-file-read-v1` | — |
| Project file read by key (file tree, browser, session pane) | socket, `project-file-read-v1` — Overseer resolves key → project ID through the catalog and falls back to the proxy only when the current transfer connection did not negotiate the capability; a negotiated socket with temporarily missing identity fails closed | — |
| Confirmed project directory listing (`?stat=1&directory=1`) | authenticated Fleet HTTP `GET /projects/:key/files/<path>?stat=1` over mesh, always | `directory=1` is stripped as an Overseer-private UI hint; Peon preserves containment and entry metadata |
| Project file metadata (`?stat=1`) | HTTP proxy only | retains `sha256`; never probes the folder socket first |
| Attachment / sandbox file read | socket, `sandbox-file-read-v1`; HTTP fallback for an older Peon | — |
| Attachment upload, project file `PUT`/`PATCH`/`DELETE` | socket, `file-write-v1`; HTTP fallback for an older Peon | — |
| Session artifact/download/preview bytes | socket, `session-artifact-v1`; HTTP fallback for an older Peon | advanced live-preview revision leases remain separate |

`session-artifact-v1` addresses the authoritative session ID plus a contained
path and reuses the project reader's metadata-first result, Range, byte credit,
cancellation, timeout, reconnect fencing and request tombstones. It also carries
tokenized HTML preview assets, so a reverse-capable Peon needs no inbound
callback for base previews. Legacy transcript events may still name an absolute
path; Peon treats it only as containment input and does not publish it as new
wire metadata.

`projectFileReadChannel`, `projectFileWriteChannel`, and
`sandboxFileWriteChannel` (`src/modules/projects/projectFileHttp.ts`) decide
file-body and mutation transports independently. Directory listings do not
enter those selectors: the web tree's `directory=1` marker is stripped while
every other raw query parameter, including repeated or encoded values, is
preserved for the one Fleet HTTP request. Peon's response remains authoritative;
there is no socket probe or fallback.

The route-level acceptance test also fixes the security boundary: project
membership is checked before dispatch, the browser-supplied key becomes the
catalog's stable project ID, the actor is derived from the authenticated
operator, and byte ranges plus the isolation headers survive the socket path.

Writes follow the same exclusive choice. A Peon that negotiated
`file-write-v1` receives attachment and project bodies as bounded 64 KiB
client-to-Peon frames under Peon-issued byte credit. It verifies the optional
`Peon-Content-Sha256`, anchors and validates the destination parent before
creating the exclusive temporary file relative to that handle, flushes the
same temp fd, revalidates containment and commits through the same anchored
directory inode using the platform's native atomic rename primitive. Cleanup
also stays fd-relative, so an open-time parent-path swap cannot create or leave
bytes outside the authorized root. Browser cancellation, socket disconnect,
limits and checksum failures remove the temporary file. Attachment
paths under `uploads/` are capped at 25 MiB and session submission retains the
ten-attachment cap; project uploads retain the 100 MiB cap. Project `PATCH`
addresses immutable project identity and performs a no-clobber same-project
move. Peon resolves and anchors the immutable project root once per move, then
derives and validates both source and destination beneath that exact root
device/inode; it never independently re-resolves the mutable configured root
pathname for each side. Admitted, opening, active and move work share one leased bound and are
fenced by socket generation and unique incarnation. Because a dispatched move
cannot be cancelled, its request-ID tombstone survives cancellation, timeout,
disconnect and generation replacement until the move settles; its outcome is
cached for replay even when stale-generation publication is suppressed. A
missing/stale canonical identity after capability negotiation returns
`PROJECT_IDENTITY_UNAVAILABLE`.
A socket refusal or disconnect is returned directly—Overseer never
replays the same mutation through HTTP. Only a Peon that did not advertise the
capability uses `proxyFileUpload`/`proxyUpload` and the legacy `PATCH`.

The public listing body retains the legacy project-file shape:
directories are `type: "dir"` (the wire channel's `"directory"` is normalized
at the route), files retain their size and modification time, and contained
symlinks retain the target's directory/file type and metadata. Escaping,
broken, or special links are inert `type: "other"` rows with null metadata.
Peon's shared Fleet HTTP file-access service resolves and contains the requested
project path before listing it, follows contained symlink targets for their
effective type and metadata, and disarms escaping, broken and special links.

## Display policy

`fileKind` decides how a fetched file is shown from the response type, the file
name and the sender's `image`/`file` hint — the sandbox serves every upload as
`application/octet-stream`, so the name and hint carry the answer. The one
deliberate difference between surfaces is the fallback for an unknown type: a
project tree is full of extensionless text (`Dockerfile`, `LICENSE`) and renders
it as text, while an attachment of an unknown binary type says it cannot be
previewed instead of rendering bytes as characters. Non-media over 1 MB is
declined with the size rather than fetched, and text is truncated at 400 000
characters.
