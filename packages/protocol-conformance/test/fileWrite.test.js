import assert from "node:assert/strict";
import test from "node:test";
import {
  executeGoldenFrames,
  FileWriteHarnessError,
  FileWriteLifecycleHarness,
  loadFixture,
} from "../src/index.js";

const fixture = loadFixture("file-write-v1.json");
const projectOpen = fixture.frames[0].frame;
const moveOpen = fixture.frames[2].frame;
const deleteOpen = fixture.frames[3].frame;

test("file-write-v1 canonical JSON and binary descriptors match released adapters", () => {
  const report = executeGoldenFrames(fixture);
  assert.equal(report.failed, 0, report.cases.filter((entry) => !entry.passed).map((entry) => entry.errors).join("\n"));
  assert.equal(report.passed, fixture.frames.length);
  assert.deepEqual(fixture.blockedCells, [
    "optimistic revision fences",
    "durable cross-daemon-restart destructive receipts",
  ]);
});

test("slow credited upload is bounded, atomic, replay-safe and cleans temporary state", () => {
  const harness = new FileWriteLifecycleHarness({
    initialCredit: 3,
    files: [["dist/app.js", Buffer.from("old")]],
  });
  const open = { ...projectOpen, contentLength: 5 };
  assert.equal(harness.open(open).credit, 3);
  assert.throws(() => harness.open(open),
    (error) => error instanceof FileWriteHarnessError && error.code === "DUPLICATE_REQUEST");
  const first = harness.chunk(open.requestId, 0, Buffer.from("hel"));
  assert.equal(first.bytes, 3);
  assert.throws(() => harness.chunk(open.requestId, 1, Buffer.from("lo")), /credit/);
  harness.grant(open.requestId, first.bytes);
  harness.chunk(open.requestId, 1, Buffer.from("lo"));
  assert.equal(harness.files.get(open.relativePath).toString(), "old", "partial temp never replaces the destination");
  const result = harness.end(open.requestId);
  assert.equal(result.status, 201);
  assert.equal(harness.files.get(open.relativePath).toString(), "hello");
  assert.equal(harness.temps.size, 0);
  assert.deepEqual(harness.open(open), result, "terminal result replays without a second effect");
  assert.throws(() => harness.open({ ...open, relativePath: "changed" }),
    (error) => error instanceof FileWriteHarnessError && error.code === "REQUEST_ID_REUSE");
});

test("faults fail closed: bounds, checksum/length, cancel, stale generation and symlink swap", () => {
  assert.throws(() => new FileWriteLifecycleHarness({ maxBodyBytes: 4 }).open(projectOpen),
    (error) => error.code === "FILE_TOO_LARGE");
  const oversized = new FileWriteLifecycleHarness();
  oversized.open(projectOpen);
  assert.throws(() => oversized.chunk(projectOpen.requestId, 0, Buffer.alloc(65_515)),
    (error) => error.code === "CREDIT_EXCEEDED");

  const mismatch = new FileWriteLifecycleHarness();
  mismatch.open(projectOpen);
  mismatch.chunk(projectOpen.requestId, 0, Buffer.from("no"));
  assert.equal(mismatch.end(projectOpen.requestId).code, "LENGTH_MISMATCH");
  assert.equal(mismatch.temps.size, 0);

  const checksum = new FileWriteLifecycleHarness();
  checksum.open({ ...projectOpen, contentLength: 5, sha256: "0".repeat(64) });
  checksum.chunk(projectOpen.requestId, 0, Buffer.from("hello"));
  assert.equal(checksum.end(projectOpen.requestId).code, "CHECKSUM_MISMATCH");

  const cancelled = new FileWriteLifecycleHarness();
  cancelled.open(projectOpen);
  assert.equal(cancelled.cancel(projectOpen.requestId), true);
  assert.equal(cancelled.end(projectOpen.requestId), false, "late end hits the tombstone, not a new write");
  assert.equal(cancelled.temps.size, 0);

  const stale = new FileWriteLifecycleHarness();
  stale.open(projectOpen);
  const generation = stale.transport.generation;
  stale.reconnect();
  assert.equal(stale.chunk(projectOpen.requestId, 0, Buffer.from("hello"), generation), false);
  assert.equal(stale.temps.size, 0);

  const swapped = new FileWriteLifecycleHarness();
  swapped.open(projectOpen);
  swapped.chunk(projectOpen.requestId, 0, Buffer.from("hello"));
  assert.equal(swapped.end(projectOpen.requestId, { symlinkSwap: true }).code, "PATH_ESCAPE");
  assert.equal(swapped.files.has(projectOpen.relativePath), false);
});

test("same-project move is atomic no-clobber and traversal never reaches a temporary file", () => {
  const harness = new FileWriteLifecycleHarness({ files: [["old.txt", Buffer.from("old")], ["occupied.txt", Buffer.from("keep")]] });
  const moved = harness.open(moveOpen);
  assert.equal(moved.path, "new.txt");
  assert.equal(harness.files.has("old.txt"), false);
  assert.equal(harness.files.get("new.txt").toString(), "old");

  assert.throws(() => harness.open({ ...moveOpen, requestId: "00000000-0000-4000-8000-000000000240", transferId: "00000000-0000-4000-8000-000000000240", commandId: "00000000-0000-4000-8000-000000000240", relativePath: "new.txt", destination: "occupied.txt" }),
    (error) => error.code === "DESTINATION_EXISTS");
  assert.equal(harness.files.get("occupied.txt").toString(), "keep");
  assert.throws(() => harness.open({ ...projectOpen, requestId: "00000000-0000-4000-8000-000000000241", transferId: "00000000-0000-4000-8000-000000000241", commandId: "00000000-0000-4000-8000-000000000241", relativePath: "../escape" }),
    (error) => error.code === "PATH_ESCAPE");
  assert.throws(() => harness.open({ ...projectOpen, requestId: "00000000-0000-4000-8000-000000000242", transferId: "00000000-0000-4000-8000-000000000229" }),
    (error) => error.code === "BAD_CORRELATION");
  assert.equal(harness.temps.size, 0);
});

test("project DELETE is one regular-file effect with replay, generation and process-local boundaries", () => {
  const harness = new FileWriteLifecycleHarness({
    files: [["obsolete.txt", Buffer.from("delete-once")], ["directory", { kind: "directory" }]],
  });
  const result = harness.open(deleteOpen);
  assert.deepEqual(result, {
    type: "write_result",
    requestId: deleteOpen.requestId,
    status: 200,
    path: "obsolete.txt",
    size: 11,
  });
  assert.equal(harness.files.has("obsolete.txt"), false);
  assert.deepEqual(harness.open(deleteOpen), result, "same-process replay cannot delete twice");
  assert.throws(() => harness.open({ ...deleteOpen, relativePath: "other.txt" }),
    (error) => error.code === "REQUEST_ID_REUSE");

  const staleGeneration = harness.transport.generation;
  harness.reconnect();
  const staleId = "00000000-0000-4000-8000-000000000249";
  harness.files.set("stale.txt", Buffer.from("preserved"));
  assert.equal(harness.open({
    ...deleteOpen, requestId: staleId, transferId: staleId, commandId: staleId, relativePath: "stale.txt",
  }, staleGeneration), false);
  assert.equal(harness.files.get("stale.txt").toString(), "preserved", "stale socket generation has no delete effect");
  assert.deepEqual(harness.open(deleteOpen), result, "socket replacement retains the process-local receipt");
  harness.processRestart();
  assert.throws(() => harness.open(deleteOpen),
    (error) => error.code === "INVALID_PATH",
    "daemon restart intentionally loses the v1 receipt; the missing file still prevents a second effect");

  const constrained = new FileWriteLifecycleHarness({
    files: [["directory", { kind: "directory" }], ["symlink", { kind: "symlink" }]],
  });
  for (const relativePath of ["directory", "symlink", "../escape"]) {
    const requestId = `00000000-0000-4000-8000-0000000002${relativePath === "directory" ? "50" : relativePath === "symlink" ? "51" : "52"}`;
    assert.throws(() => constrained.open({
      ...deleteOpen, requestId, transferId: requestId, commandId: requestId, relativePath,
    }), (error) => ["INVALID_PATH", "PATH_ESCAPE"].includes(error.code));
  }
  assert.equal(constrained.files.has("directory"), true);
  assert.equal(constrained.files.has("symlink"), true);
});
