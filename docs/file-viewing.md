# Showing a file

Every file the web client displays — a message attachment, a project file, a
documentation page, a session artifact — is named by one `FileSource` and read
through one reader. The rule for which route answers for which file lives in
`web/src/pages/peon/fileLinks.ts`, and the fetch, the size caps, the type
decision and the failure text live in `web/src/pages/peon/FileView.tsx`. A
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
client has for any message it did not just send itself, its own optimistic echo
being the only place the relative upload path survives. Joining that absolute
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
| Project file read by key (file tree, browser, session pane) | socket, `project-file-read-v1` — Overseer resolves key → project ID through the catalog and falls back to the proxy only for a Peon that holds no transfer socket | — |
| Project directory listing (`?stat=1`) | HTTP proxy | `folder-listing-v1` entries are `{ name, type }` only; the tree shows sizes, so the listing needs `size`/`mtimeMs` before it can move |
| Attachment / sandbox file read | HTTP proxy | a sandbox scope — `file_open` addresses a file by `projectId` + project-relative path, and an attachment lives in `fileTransferRoot`, outside every project |
| Attachment upload, project file `PUT`/`PATCH` | HTTP proxy | the socket has no write operation at all |

`projectFileReadChannel` (`src/modules/projects/projectFileHttp.ts`) is the one
place that decides, so each surface leaves the proxy by deleting a branch there
rather than by rewriting a route. The Peon-side channels are tracked as their
own tasks; until they land, the fallbacks are what keep an older Peon working.

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
