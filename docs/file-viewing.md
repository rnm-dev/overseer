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
private `directory=1` hint and preserves every other raw query parameter. An
upload relays no query parameter except `parents=1`.

Peon self-update packages are not file traffic: Peon fetches them directly from
the public npm registry after an owner-authorized Fleet HTTP apply request.

The project Files page is one surface, not two cards: the tree and the viewer
sit inside a single pane and share a border, and on a desktop viewport that
border is the separator the operator drags. `useSplitPane`
(`apps/web/src/shared/splitPane.ts`) owns the gesture — pointer drag, arrow
keys, a width persisted per surface — and `clampSplit` gives the trailing pane
its minimum room before the leading pane may grow, re-clamping on window
resize so a width stored on a wide monitor cannot starve the viewer in a narrow
window. Below the breakpoint the panes stack and no separator is rendered.

It is also a workspace rather than an article, so on a desktop viewport it ends
where the viewport ends. `useViewportFill`
(`apps/web/src/shared/viewportFill.ts`) measures where the pane actually starts
and claims the rest, instead of subtracting a guessed height for the fixed pane
header, the page header and a subnav that may wrap. Below its minimum, or on a
narrow viewport, the pane keeps its natural height and the page scrolls.

## One drag-and-drop layer

A file surface owns how it draws a tree; it never owns how bytes travel.
`apps/web/src/features/projects/fileTransfers.ts` holds the whole transfer
layer — the drag payload, the dropped-entry walk, and the `useFileTransfers`
hook that performs uploads and moves and reports one status. `ProjectFileTree`
is a view over that hook, so the session Files pane and the project Files page
behave identically; both accept drops and both move entries.

Dropped folders exist only as `webkitGetAsEntry` entries — `dataTransfer.files`
reports a directory as a zero-byte file — and the entry list is emptied as soon
as the drop handler yields, so entries are taken synchronously and walked
after. Names coming from the operator's filesystem are folded to single
segments, so a dropped tree can only land under the directory it was dropped
on. A walk stops at 500 files and 16 levels.

Dragging is not the only road in. Right-clicking a folder, or the empty space
around the rows (which stands for the project root), offers *Upload files* and
*Upload folder*, which drive hidden pickers through the same hook; a folder
pick reports its tree in `webkitRelativePath`. A file keeps its open/download
menu. A menu with nothing to offer — the root of a read-only tree — does not
open at all.

An upload draws itself before it exists. `pendingRows` reduces what was dropped
to one row per immediate child of the target — a plain file is its own row, a
whole folder is one row carrying every byte beneath it — and the tree sorts
those rows in among the real entries, so each appears where it will finally
live. The row shows a progress ring in the place the icon will occupy, and is
replaced by the real entry, not removed and re-added. Reporting sent bytes is
why project uploads use `apiUpload` (XHR) rather than `api`: `fetch` cannot
observe a request body leaving. A zero-byte body has no ratio to draw and
spins instead.

Uploading a folder needs directories that do not exist yet, so a nested upload
asks for them with `PUT .../files/<path>?parents=1`. Without that flag a
missing folder is still `PARENT_NOT_FOUND`; with it, Peon creates the missing
segments through the same contained walk the sandbox upload uses, which refuses
to follow a symlink out of the project root.

Deleting is the one operation with no gesture behind it. A file's menu offers
*Delete* wherever the tree may write; it opens the shared `ConfirmationDialog`,
naming the path and saying plainly that Overseer cannot restore it, and only
then sends `DELETE`. A refusal is reported by the same status strip an upload
or a move uses. Peon deletes regular files only, so a folder is never offered
the action.

Moving a folder is `PATCH` with a `destination`, exactly like moving a file.
Peon's anchored move accepts a regular file or a directory and nothing else,
keeps its no-clobber rename and its dev/inode fencing, and returns
`INVALID_PATH` when the kernel refuses to move a directory inside itself. The
tree drops the cached subtree of a moved folder rather than rewriting the paths
it held.

## Attachment paths

Transcript attachments may contain absolute Peon paths while `/files/...` is
relative to `fileTransferRoot`. `/attachments?path=` therefore resolves the
absolute path against the Peon's configured sandbox before proxying it. It
returns stable `PATH_ESCAPE` and `FILES_DISABLED` errors without exposing the
filesystem root.

## Editing

A text file opened on the project Files page can be edited in place: the
viewer header offers *Edit*, and while editing it offers *Save* and *Cancel*
in the same top-right corner. Saving is the ordinary project upload — `PUT` of
the draft over the same path — so it inherits the atomic commit, the size cap
and the refusals every other write has.

The same editor is in the preview modal a chat opens
(`ProjectFilePreviewModal`): *Edit* sits in the title bar beside download and
close, and becomes *Save* with *Cancel*/*Done* beside it while editing. The
modal is one file rather than a pane over a tree, so closing it — the X, the
backdrop, a failed save — is the moment a draft has to be asked about, and it
asks with the same three-answer `UnsavedChangesDialog` the Files page uses when
another file is opened. Which files may be written is not the surface's
opinion: `fileWriteBase` answers with the project route that takes the `PUT`,
and with `null` for an attachment or a session artifact, neither of which has
one — so those are shown, never offered an editor.

`fileEditing.ts` owns the gate and the state. `canEditFile` allows anything the
app reads as text — the kinds it refuses are the ones it cannot render either,
an image, a PDF, an archive — and only where the tree may write.
`hasUnsavedChanges` treats a draft equal to the file on disk as no change, so
opening the editor and typing nothing neither arms *Save* nor warns on the way
out. Ctrl/⌘+S saves from anywhere while an editor is open; the shortcut lives
with the hook rather than with a view, so any surface that opens an editor
gets it.

Editing is a mode the operator is in, not something done to one file: once an
editor is open, the next file they open is opened for editing too, and a save
keeps it open rather than throwing them back to the rendered view. *Done* is
the deliberate way out. A file the app cannot edit — an image, a PDF — is shown
normally and does not end the mode.

A draft is only ever seeded from the file it belongs to. The pane still holds
the previous file's text for a render or two after being pointed at a new one,
and seeding from that would let a save write one file's contents into another,
so `useFileEditor` takes `originalPath` alongside `original` and ignores the
text until the two agree.

Opening another file with a draft in hand asks first, and the question has
three answers — cancel, discard, save and go — because being offered only
"discard or stay" makes losing the work the easy path. A refused save keeps
the dialog open with its error rather than moving on. Discarding drops the
draft without leaving the editor.

After a save the reader is told its bytes are stale through `useFileContent`'s
`revision`, rather than the pane rendering the draft it happens to still hold.
Until that re-read lands the reader still reports the pre-save text, so the
draft is measured against what was written instead (`editBaseline`) — comparing
it with the stale read would re-arm *Save* the instant it finished and claim
unsaved work that is already on disk. The written text stops standing in as
soon as the reader agrees with it, or the pane moves to another file.
A re-read of the file already on screen keeps what is rendered until the new
bytes arrive (`keepsShownContent`); blanking it to a spinner and back is what a
save would otherwise look like.

Both the read-only view and the editor number their lines. The gutter is one
text node inside the scrolling box rather than a second scroller kept in sync,
stuck to the left so a horizontal scroll cannot carry it away, and neither
surface wraps — a wrapped line would make the number beside it lie. The editor
grows to its whole content and lets the box around it scroll, which is what
keeps the gutter in step without a scroll listener. `shared/lineNumbers.ts`
holds the counting: a file ending in a newline has no empty last line to
number, and an empty file is still line one, because that is where the cursor
sits.

## Images

An image fits its pane by default and is never enlarged to fill it — a 32px
icon is shown at 32px. Fitting is a state rather than a zoom level, because it
has to follow the pane as it is resized or the split is dragged. Zoom controls
sit over the image: step out, step in, fit, and a percentage label that toggles
between fitting and actual size (as does a double-click). Stepping starts from
the ratio currently on screen, so the first click after fitting moves relative
to the fitted ratio instead of jumping to a fixed level.

Fitting and zooming are one rendering path: the image is always drawn at an
explicit width and height, so nothing depends on `max-width` rules that a mode
switch could contradict. It is centred while it is smaller than the pane and
scrolls once it is larger, and every size change — a zoom step, or the pane
itself getting narrower — animates over 150ms unless the operator asks for
reduced motion. The pane is measured by its border box, so a scrollbar
appearing at high zoom cannot shrink the measured box, change the fit ratio,
remove the scrollbar and start again.

The controls live in `FileView`'s image branch, so every surface that renders a
file — the project pane, the preview modal, the attachment dialog — gets them
without knowing about them. `imageZoom.ts` holds the arithmetic.

## Display policy

Project/preview responses retain isolation headers, Range/Content-Range,
Content-Disposition, ETag and Last-Modified semantics from the Peon response.
The viewer keeps its existing type inference and size limits.
