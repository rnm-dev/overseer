# Callback addressing during the reverse-fleet cutover

OVSR-149 makes callback addressing compatibility metadata, not the authority for
an operation whose reverse capability was negotiated. The transport selector
chooses one route before either handler runs. A reverse selection keeps callback
construction lazy, so Overseer does not parse, resolve or dial the stored Peon
address.

The current rollout remains mixed-version safe:

- `OVERSEER_REVERSE_ROUTING=0` is the emergency rollback to legacy callbacks;
- `OVERSEER_LEGACY_CALLBACK_FALLBACK=0` disables compatibility fallback, but is
  **not** the default before OVSR-150, OVSR-151 and OVSR-152 pass;
- no variable deletes legacy code or schema. That remains OVSR-211;
- a Peon without the negotiated operation uses the legacy route while fallback
  is enabled. A negotiated operation uses only reverse transport and never
  retries over HTTP after a socket failure.

`OVERSEER_PEON_CALLBACK_URL` is therefore optional for Peon-initiated claims.
Leaving it empty disables legacy callback recruitment, not outbound reverse
connections. Existing legacy mesh Peons still need usable callback metadata.

The process-local callback-attempt counters are attributed to the selector
reason. In particular, `reverse-capability-authoritative` must remain zero;
tests also assert that the legacy closure is never evaluated on that path.
These counters are diagnostic groundwork for rollout telemetry, not a durable
fleet ledger.
