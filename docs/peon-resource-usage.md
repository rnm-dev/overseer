# Peon resource usage

Peon reports bounded host, daemon-process and filesystem usage through
`resource-usage-v1`. The data is operational and ephemeral: it is neither a
session statistic nor a durable fleet projection.

## Transport

- `GET /api/v1/resources` returns one authenticated, uncached sample.
- `GET /api/v1/resources/stream?intervalMs=1000` emits SSE `sample` frames.
  Peon clamps the interval to 1–10 seconds and allows at most 256 concurrent
  streams.
- The Peon Settings screen sends `resources:subscribe` and
  `resources:unsubscribe` over
  the existing workspace WebSocket. Overseer authorizes the caller, shares one
  Fleet SSE upstream per workspace/Peon pair, and relays `resources:sample`.
- The first subscriber opens the upstream and the final unsubscribe or socket
  disconnect aborts it. Reconnect establishes a fresh stream; there is no
  cursor, persistence or replay.

The high-frequency samples do not use Peon's durable control WebSocket or
outbox. The workspace snapshot advertises support for the browser subscription
protocol, while each Peon registration separately advertises whether its Fleet
API implements `resource-usage-v1`.

## Shape and safety

Samples include timestamp and sequence plus host CPU/load/memory, Peon's CPU,
RSS/heap/uptime, and total/used/available bytes for the filesystem containing
Peon's working directory. They deliberately omit mount paths, process lists,
usernames, environment variables and device identifiers.

Settings retains at most five minutes of one-second CPU and memory samples in
the current browser tab and draws the recent history locally. Leaving the
screen or reloading discards it. Disk capacity is shown as the current value;
no sample history is written to browser storage or the server.

Overseer allows eight subscriptions per browser connection and 256 shared
upstreams per process. It caps SSE buffering, closes silent or malformed
upstreams, rechecks Peon access on delivery, and relies on the existing client
WebSocket buffer cap for slow browser clients.
