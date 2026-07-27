import assert from "node:assert/strict";
import { test } from "node:test";
import { resolvePushConfig } from "./pushConfig.js";

// The credential arrives in whichever shape the environment can carry: a Docker
// env file wants one line (base64), a developer pasting into .env wants the raw
// JSON, and a mounted secret is a path. All three have to land on the same
// account, or a deploy silently loses push.

const ACCOUNT = {
  type: "service_account",
  project_id: "overseer-dev-f24fe",
  client_email: "fcm@overseer-dev-f24fe.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n",
  token_uri: "https://oauth2.googleapis.com/token",
};
const JSON_TEXT = JSON.stringify(ACCOUNT);

function noFiles(): never {
  throw new Error("no file should have been read");
}

test("no credential leaves FCM off without complaining", () => {
  const config = resolvePushConfig({}, noFiles);
  assert.equal(config.fcm, null);
  assert.deepEqual(config.warnings, []);
});

test("raw JSON, base64 and a path all resolve to the same account", () => {
  const fromJson = resolvePushConfig({ OVERSEER_PUSH_FCM_CREDENTIALS: JSON_TEXT }, noFiles);
  const fromBase64 = resolvePushConfig({ OVERSEER_PUSH_FCM_CREDENTIALS: Buffer.from(JSON_TEXT).toString("base64") }, noFiles);
  const fromPath = resolvePushConfig({ OVERSEER_PUSH_FCM_CREDENTIALS: "/run/secrets/fcm.json" }, (path) => {
    assert.equal(path, "/run/secrets/fcm.json");
    return JSON_TEXT;
  });

  assert.deepEqual(fromJson.fcm, {
    projectId: "overseer-dev-f24fe",
    clientEmail: "fcm@overseer-dev-f24fe.iam.gserviceaccount.com",
    privateKey: "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----",
    tokenUri: "https://oauth2.googleapis.com/token",
  });
  assert.deepEqual(fromBase64.fcm, fromJson.fcm);
  assert.deepEqual(fromPath.fcm, fromJson.fcm);
});

test("a key whose newlines were escaped in transit is restored", () => {
  const escaped = JSON.stringify({ ...ACCOUNT, private_key: "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n" });
  const config = resolvePushConfig({ OVERSEER_PUSH_FCM_CREDENTIALS: escaped }, noFiles);
  assert.match(config.fcm!.privateKey, /^-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----$/);
});

test("a missing token_uri falls back to Google's endpoint", () => {
  const { token_uri: _ignored, ...withoutTokenUri } = ACCOUNT;
  const config = resolvePushConfig({ OVERSEER_PUSH_FCM_CREDENTIALS: JSON.stringify(withoutTokenUri) }, noFiles);
  assert.equal(config.fcm!.tokenUri, "https://oauth2.googleapis.com/token");
});

test("an unreadable or incomplete credential warns instead of half-enabling FCM", () => {
  const broken = resolvePushConfig({ OVERSEER_PUSH_FCM_CREDENTIALS: "{not json" }, noFiles);
  assert.equal(broken.fcm, null);
  assert.equal(broken.warnings.length, 1);

  const partial = resolvePushConfig({ OVERSEER_PUSH_FCM_CREDENTIALS: JSON.stringify({ ...ACCOUNT, private_key: "" }) }, noFiles);
  assert.equal(partial.fcm, null);
  assert.match(partial.warnings[0], /missing project_id, client_email or private_key/);
});
