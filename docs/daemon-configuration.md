# Daemon configuration over Fleet HTTP

Peon owns daemon settings. Overseer's owner-only public surface:

- `GET /api/workspaces/:workspaceId/peons/:peonId/settings`
- `PATCH /api/workspaces/:workspaceId/peons/:peonId/settings`

always issues authenticated Fleet HTTP requests through mesh to Peon's
`GET/PATCH /api/v1/settings`. There is no reverse-command, projection,
negotiation, compatibility selector, or fallback path.

The remotely manageable daemon document contains exactly `name`,
`defaultAgent`, `fileTransferRoot`, `heartbeatIntervalMs`, `aiDefaultModel`,
`aiDefaultReasoningEffort`, and `soul`. Credentials, enrollment identity, URLs,
bind addresses, executable paths and `paused` are rejected rather than ignored.
The independent status route remains the authority for pausing the daemon.

Peon's GET response includes a non-secret `configuration` identity with
`epoch`, monotonic `revision`, canonical SHA-256 `digest`, and `updatedAt`.
For every public PATCH, Overseer first reads that identity and forwards it in
`Peon-Configuration-Epoch`, `Peon-Configuration-Revision`, and
`Peon-Configuration-Digest`. Peon compares the complete tuple immediately
before applying the patch and returns `409 REVISION_CONFLICT` on a stale write.
The settings file remains atomically persisted and the identity is persisted
separately, so daemon and Overseer restarts do not weaken the fence.

Validation remains at Peon: provider/model changes are evaluated together,
`aiDefaultReasoningEffort` is checked against the effective model, and an
explicit JSON `null` resets the effort to the agent/model default. Responses
contain only the safe view, revision metadata, and non-secret restart metadata.

After a successful HTTP mutation, Overseer updates the indexed Peon name and
appends an owner-only, value-free `configuration` event with operation
`daemon.configuration.changed`. Browser/mobile WebSockets therefore invalidate
their settings view, but never carry a settings request or response.
