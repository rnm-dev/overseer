# Peon-API proposal: native message attachments (files + images/vision)

> **STATUS: IMPLEMENTED on the peon (2026-07-08).** `attachments[]` is live on
> `POST /sessions` + `/followup`. Vision works via the agent's Read tool (not inline
> content blocks — the CLI has no supported path for those). Composer now sends the
> native field. Limits: ≤10/msg, ≤25 MB each, images png/jpeg/gif/webp. Error codes
> below are authoritative.

## Why
The overseer now has a session composer that can send follow-ups (`POST
/agent/v1/sessions/:id/followup { prompt }`) and multi-upload files
(`PUT /agent/v1/files/<path>`). But the two are decoupled: a message is **plain
text only**, so there's no first-class way to attach a file to a message, and
**images-for-vision are impossible** — the operator can only upload a file to the
sandbox and mention its path in the prompt, hoping the agent Reads it.

We want the operator to attach readable files **and** images the agent can *see*.
That needs a peon-side change; the overseer already forwards unknown body fields
verbatim, so **only the peon must change** — no overseer change once the field is
accepted.

## Request
Add an optional `attachments` array to the bodies of:
- `POST /agent/v1/sessions` (create)
- `POST /agent/v1/sessions/:id/followup` (continue)

```jsonc
{
  "prompt": "review the failing test and the screenshot",
  "attachments": [
    { "type": "file",  "path": "uploads/<sid>/trace.log" },          // already uploaded via /files
    { "type": "image", "path": "uploads/<sid>/screenshot.png" },     // peon reads + inlines for vision
    { "type": "image", "mediaType": "image/png", "dataBase64": "..." } // optional: inline, no pre-upload
  ]
}
```

### `Attachment` variants
- `{ type: "file", path }` — path is **relative to `fileTransferRoot`** (same sandbox
  as `/files`). Peon exposes it to the agent so it can `Read` it (text/code/logs).
- `{ type: "image", path }` — path under `fileTransferRoot`; the peon loads the bytes
  and puts them into the user turn as a **native image content block** so the model
  actually sees it (vision). Supported types: png/jpeg/gif/webp.
- `{ type: "image", mediaType, dataBase64 }` — optional convenience: inline image with
  no pre-upload (peon may still size-check). Skip in v1 if you prefer upload-only.

### Peon behavior
Assemble the user turn as content blocks: the `prompt` text + a block per
attachment (image blocks for images, and for files either a text block noting the
path or the file content, per your existing Read affordance). Response shape
unchanged.

## Constraints / errors (branch on `code`, not the string)
- `filesEnabled` must be true (a `fileTransferRoot` is set); else `503 FILES_DISABLED`.
- Unknown/missing path → `404 UNKNOWN_ATTACHMENT_PATH`. Sandbox escape → `400 PATH_ESCAPE`
  (same as `/files`).
- Oversized image / too many attachments → `413 ATTACHMENT_TOO_LARGE` (state the per-image
  and total caps — Anthropic vision limits apply).
- Unsupported image type → `415 UNSUPPORTED_MEDIA_TYPE`.
- Please document: max attachments per message, max bytes per image, accepted media types.

## Overseer side (already ready)
- `POST .../followup` forwards `req.body` verbatim + `Peon-Actor`, so `attachments`
  passes straight through with zero overseer change.
- Upload path is live: `PUT .../files/uploads/<sid>/<name>` → `201 { path, size, sha256 }`.
- The composer currently ships an **interim**: it uploads files then appends
  `Attached files:\n- <path>` to the `prompt`. When this `attachments` field lands, the
  composer swaps that assembly for the field — the upload UI is unchanged.

## Interim vs native (what changes for the operator)
- **Today (interim):** readable files work once file transfer is on; images "work"
  only if the agent chooses to `Read` them — no guaranteed vision.
- **After this change:** images render as real vision input; file attachments are
  first-class and explicit rather than glued into the prompt text.
