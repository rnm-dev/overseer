import test from "node:test";
import assert from "node:assert/strict";
import { transcriptQuery } from "./routes/peons/sessions.js";

test("transcript pagination is forwarded only to capable Peons", () => {
  assert.equal(transcriptQuery({ limit: "200", cursor: "opaque+/=" }, false), "");
  assert.equal(transcriptQuery({ limit: "200", cursor: "opaque+/=" }, true), "?limit=200&cursor=opaque%2B%2F%3D");
  assert.equal(transcriptQuery({ limit: "-1", cursor: ["a", "b"] }, true), "");
});
