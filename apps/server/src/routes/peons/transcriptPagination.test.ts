import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transcriptQuery } from "./sessions.js";

test("transcript pagination is forwarded only to capable Peons", () => {
  assert.equal(transcriptQuery({ limit: "200", cursor: "opaque+/=" }, false), "");
  assert.equal(transcriptQuery({ limit: "200", cursor: "opaque+/=" }, true), "?limit=200&cursor=opaque%2B%2F%3D");
  assert.equal(transcriptQuery({ limit: "-1", cursor: ["a", "b"] }, true), "");
});

test("transcript page route has one direct Fleet HTTP path and no projection demand", async () => {
  const source = await readFile(new URL("./sessions.ts", import.meta.url), "utf8");
  const start = source.indexOf('router.get(`${wp}/sessions/:sid/transcript`');
  const end = source.indexOf("router.post(\n    `${wp}/sessions`", start);
  assert.ok(start >= 0 && end > start);
  const route = source.slice(start, end);
  assert.ok(route.includes("callPeon(connOfRecord(c.record)"));
  assert.ok(route.includes("/transcript${query}"));
  assert.doesNotMatch(route, /readTranscriptPage|acquireTranscriptProjection|transcript_snapshot_request/);
});
