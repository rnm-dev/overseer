# Transcript pagination

Paginated transcript reads use a durable sidecar index next to each authoritative session JSONL
file. The JSONL remains the source of truth and is never rewritten during indexing or recovery.

## Read path

- `<session>.jsonl.idx` contains one compact record per physical JSONL row: byte offset, byte
  length, physical line number, and the resolved durable event ID. Invalid rows have a null event
  ID so they remain part of physical line numbering without becoming visible events.
- `<session>.jsonl.idx.meta.json` binds the index to the transcript byte length and modification
  time. It is replaced atomically after the index data is durable.
- Newest and older pages reverse-read the index in 64 KiB chunks and read only the selected event
  rows from the transcript. A normal page therefore parses at most `limit` transcript rows and
  examines at most the selected row bytes plus a small index-chunk overhead.
- Version 2 cursors are opaque, session-bound, and carry both the immutable first-page `eventId`
  and its byte position in the sidecar. Version 1 event-ID-only cursors remain accepted during the
  compatibility window. Version 2 offsets are accepted only at verified index-record boundaries;
  a forged offset is rejected as `BAD_CURSOR` without triggering an expensive index rebuild.

Append and paginated-read operations share a per-session asynchronous queue. The transcript row
is written before its index record and atomic metadata update. A reader therefore observes the
state before or after an append, never a partial row or an index entry ahead of the transcript.

## Recovery and compatibility

A missing, stale, truncated, or malformed index is rebuilt asynchronously from the authoritative
transcript. Rebuild preserves the existing legacy event-ID algorithm, including physical line
numbers, duplicate rows, malformed middle rows, and partial final rows. Recovery never deletes or
rewrites valid transcript data. The intentionally full legacy unpaged endpoint and SSE replay keep
their existing response and resume behavior.

Each paginated read emits a content-free structured log with cold/warm state, transcript and index
bytes examined, rows parsed, events returned, rebuild/recovery flags, and elapsed milliseconds.

Run the representative benchmark with:

```sh
npm run benchmark:transcript-pagination
```

Use `-- --sizes=10` for a quick local smoke benchmark.

## Reference benchmark

Measured on 2026-07-21 with 16 KiB representative event rows. `bytes examined` below counts the
authoritative transcript bytes; each bounded read additionally examined one 64 KiB index chunk.

| Transcript | Path | Latency | Transcript bytes examined | Rows parsed | RSS delta |
|---:|---|---:|---:|---:|---:|
| 10 MB | previous full synchronous read | 7.23 ms | 10,494,242 | 638 | 37.3 MB |
| 10 MB | indexed newest 50 | 1.16 ms | 822,450 | 50 | 0.0 MB |
| 10 MB | indexed older 50 | 1.46 ms | 822,450 | 50 | 0.0 MB |
| 100 MB | previous full synchronous read | 75.40 ms | 104,872,905 | 6,375 | 365.8 MB |
| 100 MB | indexed newest 50 | 1.26 ms | 822,550 | 50 | 0.0 MB |
| 100 MB | indexed older 50 | 1.27 ms | 822,550 | 50 | 0.0 MB |
| 500 MB | previous full synchronous read | 727.89 ms | 524,301,984 | 31,868 | 1,319.7 MB |
| 500 MB | indexed newest 50 | 1.23 ms | 822,650 | 50 | 0.0 MB |
| 500 MB | indexed older 50 | 1.29 ms | 822,650 | 50 | 0.0 MB |

The one-time asynchronous recovery/index build is intentionally reported separately by runtime
metrics. It took 26.28 ms, 120.65 ms, and 559.60 ms for the 10, 100, and 500 MB fixtures
respectively, while yielding to unrelated event-loop work.
