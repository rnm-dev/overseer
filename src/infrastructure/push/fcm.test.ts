import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createFcmSender, PushDeliveryError } from "./fcm.js";
import type { FcmServiceAccount } from "./pushConfig.js";

// What is asserted here is the wire contract with Google: a service-account JWT
// that its token endpoint will accept, a v1 message body FCM will not reject,
// and the difference between "try again later" and "this device is gone".

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const ACCOUNT: FcmServiceAccount = {
  projectId: "overseer-9fe46",
  clientEmail: "fcm@overseer-9fe46.iam.gserviceaccount.com",
  privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  tokenUri: "https://oauth2.googleapis.com/token",
};

const MESSAGE = { title: "Kanat", body: "Session needs a human", data: { workspaceId: "w1", sessionId: null, cursor: 42 } };

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

interface Call { url: string; init: RequestInit | undefined }

// Answers the token exchange, then hands every send to `respond`.
function stubFetch(respond: (body: Record<string, unknown>) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === ACCOUNT.tokenUri) return Response.json({ access_token: `token-${calls.length}`, expires_in: 3600 });
    return respond(JSON.parse(String(init?.body)) as Record<string, unknown>);
  };
  return calls;
}

test("a send signs a service-account JWT and posts a v1 message", async () => {
  const calls = stubFetch(() => Response.json({ name: "projects/overseer-9fe46/messages/1" }));

  await createFcmSender(ACCOUNT).send("device-token", MESSAGE);

  const [exchange, send] = calls;
  assert.equal(exchange.url, "https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(String(exchange.init?.body));
  assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");

  const [header, claims, signature] = String(form.get("assertion")).split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${claims}`);
  assert.ok(verifier.verify(publicKey, Buffer.from(signature, "base64url")), "assertion must verify against the service account key");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const payload = JSON.parse(Buffer.from(claims, "base64url").toString()) as Record<string, unknown>;
  assert.equal(payload.iss, ACCOUNT.clientEmail);
  assert.equal(payload.scope, "https://www.googleapis.com/auth/firebase.messaging");
  assert.equal(payload.aud, ACCOUNT.tokenUri);

  assert.equal(send.url, "https://fcm.googleapis.com/v1/projects/overseer-9fe46/messages:send");
  assert.equal((send.init?.headers as Record<string, string>).Authorization, "Bearer token-1");
  const message = (JSON.parse(String(send.init?.body)) as { message: Record<string, unknown> }).message;
  assert.equal(message.token, "device-token");
  assert.deepEqual(message.notification, { title: "Kanat", body: "Session needs a human" });
  // FCM data is string→string, and a null member is absent rather than "null".
  assert.deepEqual(message.data, { workspaceId: "w1", cursor: "42" });
});

test("the access token is minted once and reused across sends", async () => {
  const calls = stubFetch(() => Response.json({ name: "ok" }));
  const sender = createFcmSender(ACCOUNT);

  await Promise.all([sender.send("a", MESSAGE), sender.send("b", MESSAGE)]);
  await sender.send("c", MESSAGE);

  assert.equal(calls.filter((c) => c.url === ACCOUNT.tokenUri).length, 1);
});

test("an expired token buys one retry, not a wedged sender", async () => {
  let sends = 0;
  const calls = stubFetch(() => {
    sends += 1;
    return sends === 1
      ? Response.json({ error: { status: "UNAUTHENTICATED", message: "invalid authentication credentials" } }, { status: 401 })
      : Response.json({ name: "ok" });
  });
  const sender = createFcmSender(ACCOUNT);

  await sender.send("a", MESSAGE);
  await sender.send("b", MESSAGE);

  assert.equal(calls.filter((c) => c.url === ACCOUNT.tokenUri).length, 2);
  assert.equal(sends, 3);
});

test("an unregistered device is permanent, an upstream fault is not", async () => {
  stubFetch(() => Response.json(
    { error: { status: "NOT_FOUND", message: "Requested entity was not found.", details: [{ errorCode: "UNREGISTERED" }] } },
    { status: 404 },
  ));
  await assert.rejects(createFcmSender(ACCOUNT).send("dead-token", MESSAGE), (err: PushDeliveryError) => {
    assert.equal(err.permanent, true);
    assert.match(err.message, /FCM responded 404/);
    return true;
  });

  stubFetch(() => Response.json({ error: { status: "UNAVAILABLE", message: "The service is currently unavailable." } }, { status: 503 }));
  await assert.rejects(createFcmSender(ACCOUNT).send("live-token", MESSAGE), (err: PushDeliveryError) => {
    assert.equal(err.permanent, false);
    return true;
  });
});

test("a refused token exchange fails the send without retiring the device", async () => {
  globalThis.fetch = async () => Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 });
  await assert.rejects(createFcmSender(ACCOUNT).send("device-token", MESSAGE), (err: PushDeliveryError) => {
    assert.equal(err.permanent, false);
    assert.match(err.message, /token exchange responded 400/);
    return true;
  });
});
