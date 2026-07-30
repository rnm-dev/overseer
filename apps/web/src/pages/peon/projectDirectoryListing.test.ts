import assert from "node:assert/strict";
import test from "node:test";
import { requestProjectDirectory } from "./projectDirectoryListing";

test("concurrent directory readers share one in-flight request but settled reads do not cache", async () => {
  let calls = 0;
  let resolve!: (value: { entries: { name: string }[] }) => void;
  const request = async () => {
    calls += 1;
    return new Promise<{ entries: { name: string }[] }>((done) => { resolve = done; });
  };

  const first = requestProjectDirectory("/files", "src", request);
  const second = requestProjectDirectory("/files", "src", request);
  assert.equal(calls, 1);
  assert.equal(first, second);

  resolve({ entries: [{ name: "index.ts" }] });
  assert.deepEqual(await first, [{ name: "index.ts" }]);
  assert.deepEqual(await second, [{ name: "index.ts" }]);

  const refreshed = requestProjectDirectory("/files", "src", async () => {
    calls += 1;
    return { entries: [{ name: "next.ts" }] };
  });
  assert.notEqual(refreshed, first);
  assert.deepEqual(await refreshed, [{ name: "next.ts" }]);
  assert.equal(calls, 2);
});

test("a failed directory read is released for retry", async () => {
  await assert.rejects(requestProjectDirectory("/files", "retry", async () => {
    throw new Error("offline");
  }), /offline/);

  assert.deepEqual(await requestProjectDirectory("/files", "retry", async () => ({
    entries: [{ name: "recovered" }],
  })), [{ name: "recovered" }]);
});
