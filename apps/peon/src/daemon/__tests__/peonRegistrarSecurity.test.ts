import assert from "node:assert/strict";
import test from "node:test";
import { northError } from "../overseer/peonRegistrar.js";

function errorResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 401,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

test("registrar exposes only allowlisted credential verdicts and never remote messages", async () => {
  const secret = "remote-secret-body-must-not-escape";
  const allowed = await northError("register", errorResponse(JSON.stringify({
    code: "CREDENTIAL_REVOKED",
    message: secret,
    bearer: `pn_${"A".repeat(32)}`,
  })));
  assert.equal(allowed.code, "CREDENTIAL_REVOKED");
  assert.equal(allowed.message, "register -> 401");
  assert.doesNotMatch(JSON.stringify(allowed), new RegExp(secret));
  assert.doesNotMatch(allowed.message, /pn_/);

  const unknown = await northError("heartbeat", errorResponse(JSON.stringify({
    code: "FUTURE_REMOTE_VERDICT",
    message: secret,
  })));
  assert.equal(unknown.code, "");
  assert.equal(unknown.message, "heartbeat -> 401");
  assert.doesNotMatch(JSON.stringify(unknown), new RegExp(secret));
});

test("registrar bounds both declared and streamed error bodies at 16 KiB", async () => {
  const oversizedVerdict = JSON.stringify({
    code: "CREDENTIAL_REVOKED",
    message: "x".repeat(17 * 1024),
  });
  const declared = await northError("register", errorResponse(
    oversizedVerdict,
    { "Content-Length": String(Buffer.byteLength(oversizedVerdict)) },
  ));
  assert.equal(declared.code, "");
  assert.equal(declared.message, "register -> 401");

  const encoder = new TextEncoder();
  const chunk = encoder.encode("x".repeat(9 * 1024));
  let pulls = 0;
  const streamed = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(chunk);
      if (pulls === 2) controller.close();
    },
  }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
  const streamedError = await northError("heartbeat", streamed);
  assert.equal(streamedError.code, "");
  assert.equal(streamedError.message, "heartbeat -> 401");
  assert.equal(pulls, 2);
});
