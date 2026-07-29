import { once } from "node:events";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const root = mkdtempSync(path.join(os.tmpdir(), "peon-transcript-benchmark-"));
process.env.XDG_STATE_HOME = root;

const {
  forgetTranscript,
  observeTranscriptReads,
  readTranscriptPage,
  sessionsDir,
  transcriptPath,
} = await import("../src/daemon/sessionArtifacts.js");

const sizesArg = process.argv.find((arg) => arg.startsWith("--sizes="))?.slice("--sizes=".length) ?? "10,100,500";
const sizesMb = sizesArg.split(",").map(Number).filter((size) => Number.isFinite(size) && size > 0);
const payload = "x".repeat(16 * 1024);

interface Result {
  sizeMb: number;
  mode: string;
  latencyMs: number;
  bytesExamined: number;
  rowsParsed: number;
  rssDeltaMb: number;
}

async function writeFixture(id: string, targetBytes: number): Promise<number> {
  mkdirSync(sessionsDir, { recursive: true });
  const stream = createWriteStream(transcriptPath(id), { mode: 0o600 });
  let bytes = 0;
  let rows = 0;
  while (bytes < targetBytes) {
    const line = `${JSON.stringify({ type: "user_message", text: `${rows}:${payload}`, _peonEventId: `event-${rows}` })}\n`;
    bytes += Buffer.byteLength(line);
    rows += 1;
    if (!stream.write(line)) await once(stream, "drain");
  }
  stream.end();
  await once(stream, "close");
  return rows;
}

function baseline(id: string, sizeMb: number): Result {
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  const started = performance.now();
  const source = readFileSync(transcriptPath(id), "utf8");
  let rows = 0;
  for (const line of source.split("\n")) {
    if (!line) continue;
    JSON.parse(line);
    rows += 1;
  }
  return {
    sizeMb,
    mode: "before/full-sync",
    latencyMs: performance.now() - started,
    bytesExamined: Buffer.byteLength(source),
    rowsParsed: rows,
    rssDeltaMb: (process.memoryUsage().rss - rssBefore) / 1024 / 1024,
  };
}

async function bounded(id: string, sizeMb: number, mode: string, cursor?: string): Promise<{ result: Result; cursor?: string }> {
  global.gc?.();
  const rssBefore = process.memoryUsage().rss;
  let metrics: { fileBytesExamined: number; rowsParsed: number; elapsedMs: number } | null = null;
  observeTranscriptReads((value) => { metrics = value; });
  const page = await readTranscriptPage(id, "claude-code", { limit: 50, cursor });
  observeTranscriptReads(null);
  if (!metrics) throw new Error("transcript metrics were not emitted");
  return {
    result: {
      sizeMb,
      mode,
      latencyMs: metrics.elapsedMs,
      bytesExamined: metrics.fileBytesExamined,
      rowsParsed: metrics.rowsParsed,
      rssDeltaMb: (process.memoryUsage().rss - rssBefore) / 1024 / 1024,
    },
    cursor: page.nextCursor ?? undefined,
  };
}

const results: Result[] = [];
try {
  for (const sizeMb of sizesMb) {
    const id = `benchmark-${sizeMb}mb`;
    await writeFixture(id, sizeMb * 1024 * 1024);
    results.push(baseline(id, sizeMb));
    await readTranscriptPage(id, "claude-code", { limit: 50 }); // one-time upgrade/recovery build
    forgetTranscript(id); // simulate a daemon restart with a durable sidecar
    const newest = await bounded(id, sizeMb, "after/newest-50");
    results.push(newest.result);
    results.push((await bounded(id, sizeMb, "after/older-50", newest.cursor)).result);
  }
  console.table(results.map((result) => ({
    sizeMB: result.sizeMb,
    mode: result.mode,
    latencyMs: result.latencyMs.toFixed(2),
    bytesExamined: result.bytesExamined,
    rowsParsed: result.rowsParsed,
    rssDeltaMB: result.rssDeltaMb.toFixed(1),
  })));
} finally {
  rmSync(root, { recursive: true, force: true });
}
