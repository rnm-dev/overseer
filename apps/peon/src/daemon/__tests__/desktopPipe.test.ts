import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";
import { MAX_FRAME_BYTES, servePipe } from "../../desktop/pipeRpc.js";

const tick = () => new Promise(resolve => setImmediate(resolve));
test("desktop pipe handles fragmented requests in order and hides raw errors", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", data => { text += data; });
  let closed = false;
  servePipe(input, output, async method => {
    if (method === "fail") throw new Error("private credential");
    return method;
  }, () => { closed = true; });
  input.write('{"id":1,"method":"sta');
  input.write('tus"}\n{"id":2,"method":"fail"}\n');
  await tick();
  assert.deepEqual(text.trim().split("\n").map(line => JSON.parse(line)), [
    { id: 1, result: "status" }, { id: 2, error: "REQUEST_FAILED" },
  ]);
  assert.equal(closed, false);
  input.end();
  await tick();
  assert.equal(closed, true);
});

test("oversized and invalid desktop frames close without dispatching", async () => {
  for (const frame of ["x".repeat(MAX_FRAME_BYTES + 1), '{"id":-1,"method":"status"}\n', "null\n"]) {
    let closed = false;
    let calls = 0;
    const input = new PassThrough();
    servePipe(input, new PassThrough(), async () => { calls++; }, () => { closed = true; });
    input.write(frame);
    await tick();
    assert.equal(closed, true);
    assert.equal(calls, 0);
  }
});
