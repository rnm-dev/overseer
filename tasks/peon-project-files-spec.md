# Peon-API proposal: per-project file browse (read-only)

## Why
The overseer wants a file browser when you open a project: navigate the project's
folders, and view files. The project's working directory (`GET /projects/:key` →
`dir`, e.g. `/rnm/websitev2`) is **outside** the `fileTransferRoot` sandbox, and the
existing `/files/*` API only serves that sandbox — so it can't read project files.
This was on the "deliberately not exposed" list; we'd like it exposed now, read-only.

(Note: `GET /agent/v1/projects/:key/files` currently returns `401 "not authenticated"`
— looks like the dashboard has browse logic under a different auth realm. We want it
on `/agent/v1` behind the standard `Bearer <overseerToken>` gate.)

## Request — mirror the existing `/files` contract, rooted at the project dir
Reuse your `/files` implementation but sandbox to the project's `dir` instead of
`fileTransferRoot`:

```
GET /agent/v1/projects/:key/files/<path>?stat=1
    → directory listing (when <path> is a dir) or file metadata
      dir:  { path, entries: [ { name, type: "dir"|"file", size?, mtimeMs? } ] }
      file: { path, type: "file", size, mtimeMs, sha256? }
GET /agent/v1/projects/:key/files/<path>
    → file content download; Content-Type by extension; Range: supported (206)
```

- `<path>` is **relative to the project's `dir`**; empty/`/` = project root.
- Sandboxed to `dir`; escape ⇒ `400 PATH_ESCAPE` (same as `/files`).
- Unknown project ⇒ `404 UNKNOWN_PROJECT`; missing path ⇒ `404 NOT_FOUND`.
- **Read-only** — no PUT/DELETE on this route (uploads stay on `/files`).
- Standard machine auth (`Bearer <overseerToken>`), `Peon-Actor` honored.
- Nice-to-haves (optional): honor `.gitignore`, a `?depth=` for a shallow tree,
  and a sane max size for content reads (return metadata + a "too large to view"
  flag rather than streaming a 500 MB file into a viewer).

## Overseer side (what we'll build against this)
- Proxy `GET ${wp}/projects/:key/files/{*rest}` → the two calls above (stat listing
  as JSON via callPeon; content download via the streamed file proxy, forwarding
  `Range`). No peon change needed on the overseer beyond adding the route.
- UI: a new **project detail page** (`/peons/:id/projects/:key`) with the detail
  card + a file tree/list and a file viewer (text + image). Degrades to a
  "peon needs update" note until this endpoint ships.

## Errors to branch on (never the string)
`UNKNOWN_PROJECT`, `NOT_FOUND`, `PATH_ESCAPE`, plus `FILES_TOO_LARGE` if you add a
view cap.
