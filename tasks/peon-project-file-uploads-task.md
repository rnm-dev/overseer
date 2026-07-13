# Peon task: project-scoped file uploads

## Context

Overseer now provides drag-and-drop uploads in a session's project file tree.
Dropping on the pane targets the project root; dropping on a folder targets that
relative directory. Overseer streams the raw request body to the selected Peon,
but current Peons expose project files as read-only and therefore reject the
write.

Implement the project-scoped upload endpoint below. It must use the same machine
Bearer authentication and `Peon-Actor` handling as existing project-file reads.
The same file tree also supports moving an existing file between project folders.

## API contract

```http
PUT /api/v1/projects/:key/files/{*path}
Content-Type: application/octet-stream
Peon-Content-Sha256: <hex>   # optional

<raw file bytes>
```

Success:

```http
201 Created
Content-Type: application/json

{ "path": "src/assets/logo.png", "size": 18421, "sha256": "..." }
```

The path is relative to the configured project's `dir`. A repeated PUT to the
same path replaces the existing regular file atomically. Parent directories must
already exist; the upload endpoint must not create an arbitrary directory tree.

### Move contract

```http
PATCH /api/v1/projects/:key/files/{*sourcePath}
Content-Type: application/json

{ "destination": "relative/destination/path.txt" }
```

Success returns `200 { "path", "size", "sha256"? }`. Move only regular files,
remain inside the same project root, require the destination parent to exist,
and use an atomic filesystem rename. Return `409 DESTINATION_EXISTS` rather than
overwriting an existing destination.

## Required behavior

- Authenticate with the standard `/api/v1` machine credential.
- Resolve `:key` through the existing project registry.
- Stream the body to a temporary file inside the destination directory; do not
  buffer the complete upload in memory.
- Compute SHA-256 while streaming.
- If `Peon-Content-Sha256` is present, compare it before commit. On mismatch,
  delete the temporary file and return `409 CHECKSUM_MISMATCH`.
- Flush and atomically rename the temporary file over the final destination only
  after the complete body succeeds.
- Honor the existing upload-size limit, if configured, and return a stable
  `413 FILE_TOO_LARGE` error.
- Preserve the destination directory's normal file permissions policy. Do not
  copy executable bits or other metadata from client input.
- Clean up temporary files after aborts, disconnects, checksum failures, and all
  other errors.
- Continue supporting spaces, Unicode, and URL-encoded path segments.
- Validate both PATCH source and destination using the same canonical sandbox
  rules. Reject cross-project moves and moves onto the same path.

## Security requirements

- Canonicalize both the project root and requested destination.
- Reject absolute paths, `..`, encoded traversal, NUL bytes, and malformed path
  segments.
- Reject symlink escapes in every existing parent component and at the final
  destination. The committed file must remain inside the selected project's
  canonical root.
- Reject a destination that is a directory or non-regular file.
- Never fall back to `fileTransferRoot`, another project's directory, or the
  process working directory.
- Do not weaken the existing read-route sandbox to implement writes.

## Stable errors

- `404 UNKNOWN_PROJECT` — project key does not exist.
- `404 PARENT_NOT_FOUND` — destination parent directory does not exist.
- `400 PATH_ESCAPE` — path escapes or fails canonicalization.
- `400 INVALID_PATH` — empty filename, directory destination, or malformed path.
- `403 FORBIDDEN` — policy intentionally excludes the destination.
- `409 CHECKSUM_MISMATCH` — supplied digest differs from streamed content.
- `409 DESTINATION_EXISTS` — PATCH destination already exists.
- `413 FILE_TOO_LARGE` — configured upload limit exceeded.
- `500 WRITE_FAILED` — safe write failed without committing a partial file.

Return JSON `{ "error": string, "code": string }` for every failure.

## Compatibility

- Keep existing `GET /api/v1/projects/:key/files/{*path}` behavior unchanged.
- Unsupported mutation methods remain `404` or `405`.
- Overseer does not require the checksum header for browser drops, so uploads
  without it must work; the response must still include the computed digest.
- The endpoint should match the existing `/files/*` upload implementation where
  possible, with the sandbox root supplied by the selected project.
- PATCH is a move, not a copy: after success the source must no longer exist.

## Acceptance tests

1. Upload a text file to the project root and verify its bytes through the GET
   project-file endpoint.
2. Upload into an existing nested folder containing spaces and Unicode.
3. Replace an existing regular file and prove readers observe either the old or
   new complete content, never a partial write.
4. Upload multiple files sequentially through one authenticated operator.
5. Verify correct and incorrect `Peon-Content-Sha256` handling.
6. Abort a large upload midway and verify no destination or temporary file is
   left behind.
7. Reject unknown projects, absent parents, directory destinations, traversal,
   encoded traversal, absolute paths, NULs, and symlink escapes with the stable
   codes above.
8. Prove one project cannot write into another project or `fileTransferRoot`.
9. Verify the size limit without retaining a partial file.
10. Run the existing project-file read and transfer-sandbox suites unchanged.
11. Move a file from the root into a nested folder and back to the root.
12. Reject a move onto an existing path without modifying either file.
13. Reject traversal, symlink escape, directory sources, cross-project
    destinations, missing parents, and same-path moves.

## Definition of done

- All acceptance tests are automated in the Peon repository.
- A real Overseer browser drop to the root and to a nested folder returns 201,
  appears immediately in the tree, and downloads with identical bytes.
- Dragging an existing file onto a folder or the project-root drop zone moves it
  atomically and the next project-file listing reflects the new location.
- Failed and aborted uploads leave no partial destination or temporary files.
- Peon's API documentation describes the endpoint and stable errors.
