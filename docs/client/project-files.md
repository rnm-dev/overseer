# Project file browser

Session and project detail share a full-screen, read-only project tree and file
viewer.

## Data contract

Directories are loaded from:

```text
GET /api/workspaces/:workspaceId/peons/:peonId/projects/:projectKey/files/:path?stat=1
```

The root request keeps the trailing slash after `files`. Each path segment is
encoded independently. Responses contain an `entries` array whose items have a
`name`, `type`, and optional `size` and `mtimeMs`.

Plain `?stat=1` remains an HTTP request. The web tree adds `directory=1` when
it already knows the target is a directory; Overseer may then serve that
listing through the Peon's authenticated Fleet HTTP project-files API
operation when `entry-metadata-v1` was negotiated. Older Peons keep the HTTP
fallback, with the marker stripped. Individual-file `?stat=1` stays exclusively
on HTTP because that response includes `sha256`.

The public response remains the legacy shape: directories are `dir`, regular
files are `file`, contained symlinks use their target's `dir`/`file` shape, and
escaping, broken, or special links are inert `other` rows. The client sorts
directories before files, then sorts each group by case-insensitive name.
`directory` is still accepted defensively for older or direct responses.

## Presentation

- The root directory loads when the screen opens.
- Child directories load only when first expanded.
- Expanded directories remain open during manual refresh.
- A refresh reloads the expanded portion of the tree.
- In the web session sidebar, each completed agent turn and each inline save
  revalidates the expanded portion of the tree without collapsing it.
- Both web file trees also revalidate expanded folders every two seconds while
  the tab is visible, including during an agent turn. Focus, reconnect and
  returning to the tab trigger an immediate refresh. Closing the tree stops
  polling; slow requests never overlap, and directory reads bypass browser cache.
- Root and nested failures have retry actions.
- Sessions without a project show a truthful no-project state.
- File rows show type-aware icons and sizes and open a full-screen viewer.
- PDF files render with page scrolling, zoom, selection, and link support.
- Markdown uses GitHub-flavored rendering. Fenced code is syntax highlighted,
  and `mermaid` fences render as pannable and zoomable diagrams. Markdown files
  can switch between Read and Code.
- Source-like files use extension-aware syntax highlighting. Text previews are
  capped at 400,000 rendered characters so unusually large files do not lock
  the UI.
- HTML files can switch between browser Preview and Code. Browser Preview runs
  in an isolated local document, blocks navigation and network subresources,
  and allows only inline scripts/styles plus data/blob media. Android, iOS, and
  macOS embed the preview. Windows and Linux expose an Open Preview action that
  opens the same isolated document in a separate native WebView2 or WebKitGTK
  window; Code mode remains available in the main app.
- Images retain the existing pan-and-zoom preview.

The format renderer and its controlled Preview/Code switch live in the shared
widget layer as `FileViewBlock` and `FileViewModeSwitch`. They accept a path,
raw bytes, and an optional content type without depending on project-domain
models, so attachments and other byte-backed file surfaces can reuse the same
rendering behavior. Project screens remain responsible for loading files,
navigation, and error/retry states.

## Limits

The browser does not edit, upload, or move project files. HTML preview does not
resolve relative assets. File contents are fetched on open and are not
persisted in the app cache. Windows and Linux write the isolated HTML document
and an ephemeral WebView profile to operating-system temporary storage and
remove that directory after the preview window closes.
