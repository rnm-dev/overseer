import assert from "node:assert/strict";
import test from "node:test";
import { prettyJsonOutput } from "./parsing";

test("prettyJsonOutput indents JSON objects and arrays", () => {
  assert.equal(prettyJsonOutput('{"ok":true,"items":[1,2]}'), `{
  "ok": true,
  "items": [
    1,
    2
  ]
}`);
  assert.equal(prettyJsonOutput('[{"id":1}]'), `[
  {
    "id": 1
  }
]`);
});

test("prettyJsonOutput leaves non-JSON and primitive output alone", () => {
  assert.equal(prettyJsonOutput("command output"), null);
  assert.equal(prettyJsonOutput("{not json}"), null);
  assert.equal(prettyJsonOutput("42"), null);
  assert.equal(prettyJsonOutput('"text"'), null);
});
