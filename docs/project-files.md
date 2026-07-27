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

The client sorts directories before files, then sorts each group by
case-insensitive name. Both `dir` and `directory` are accepted as directory
types for compatibility with the web client and server responses.

## Presentation

- The root directory loads when the screen opens.
- Child directories load only when first expanded.
- Expanded directories remain open during manual refresh.
- A refresh reloads the expanded portion of the tree.
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
