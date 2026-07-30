# Peon update channel

Peon update checks and approved self-updates use the negotiated
`reverse-command-v1` dispatcher as `update.check` and `update.apply`. Overseer
uses the reverse command only when the connected Peon advertises the exact
operation; older Peons keep the exclusive legacy HTTP route.

The release source is unchanged. A global Peon reads authenticated release
metadata from its enrolled Overseer, downloads that Overseer-served npm
archive, enforces its byte length and SHA-256, validates the installed compiled
output, and keeps a locally packed rollback archive. Public npm is not the
enrolled fleet update channel.

Before `update.apply` admission, Overseer resolves the approved release once
and binds its version, immutable release revision and SHA-256 into the canonical
command payload. The Peon re-fetches metadata immediately before download and
returns `RELEASE_CHANGED` if any of the three fields changed.

`update.apply` is admitted to the shared durable command ledger before the
updater starts. The detached updater durably writes a mode-0600 receipt carrying
only the command ID, initiating process ID, and expected
version/revision/SHA-256. After verifying and installing the exact archive it
writes the same bounded identity into the installed package. The replacement
daemon completes the same command only when it has a different PID and its
running package reports the exact three-field identity. Updated files, a
matching version alone, or a matching version with a different revision or
digest are not sufficient. Duplicate delivery replays the existing lifecycle
instead of reinstalling or restarting.

The updater re-fetches release metadata but refuses to proceed if the approved
version changed before download. Stable outcomes distinguish no update,
registry unavailability, changed release, download failure, archive-integrity
failure, policy rejection, install/restart failure with rollback, restart
timeout, and attestation mismatch. Credentials and archive URLs stay out of
receipts, results, and routine logs.
