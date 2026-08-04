import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, test } from "node:test";
import type pg from "pg";
import { newDb } from "pg-mem";
import { config } from "./config.js";
import { initDb, query } from "./infrastructure/db/index.js";
import { resolveVoiceConfig } from "./infrastructure/voice/index.js";
import { resetVoiceQuota } from "./modules/voice/index.js";
import { createServer } from "./server.js";

// The route end to end: raw audio in, cleaned text out, with the provider
// faked at the fetch boundary. No network, and no audio ever touches disk.

let server: http.Server;
let port: number;
const realFetch = globalThis.fetch;
const originalVoice = config.voice;

const DEVICE_TOKEN = "device-1.secret-1";
const TEST_MAX_BYTES = 8_192;

let sttResponse = (): Response => Response.json({ text: "ну короче задеплой канат на прод", language: "ru" });
let polishResponse = (): Response => Response.json({ choices: [{ message: { content: "Задеплой Kanat на прод." } }] });
let sttCalls = 0;

before(async () => {
  const mem = newDb();
  const adapter = mem.adapters.createPg();
  await initDb(new adapter.Pool() as unknown as pg.Pool);
  await query(`INSERT INTO users (id,email,created_at) VALUES ('u1','voice@example.test',1)`);
  await query(`INSERT INTO devices (id,user_id,token_hash,created_at,expires_at) VALUES ('device-1','u1',$1,1,9999999999999)`, [
    createHash("sha256").update("secret-1").digest("hex"),
  ]);
  await query(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('w1','Voice','voice',1)`);
  await query(`INSERT INTO workspaces (id,name,slug,created_at) VALUES ('w2','Other','other',1)`);
  await query(`INSERT INTO workspace_members (workspace_id,user_id,role,added_at) VALUES ('w1','u1','owner',1)`);

  // express.raw's limit is fixed when the router is built, so the voice config
  // has to be in place before the server is composed.
  config.voice = resolveVoiceConfig({
    OVERSEER_VOICE: "groq",
    OVERSEER_VOICE_API_KEY: "test-key",
    OVERSEER_VOICE_MAX_BYTES: String(TEST_MAX_BYTES),
    OVERSEER_VOICE_MAX_DURATION_MS: "120000",
  });

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(`http://127.0.0.1:${port}`)) return realFetch(input, init);
    if (url.endsWith("/audio/transcriptions")) { sttCalls += 1; return sttResponse(); }
    if (url.endsWith("/chat/completions")) return polishResponse();
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof globalThis.fetch;

  server = http.createServer(createServer());
  port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
});

after(async () => {
  globalThis.fetch = realFetch;
  config.voice = originalVoice;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  resetVoiceQuota();
  sttCalls = 0;
});

interface Sent {
  status: number;
  body: Record<string, unknown>;
  serverTiming: string | null;
  retryAfter: string | null;
}

async function dictate(options: { query?: string; contentType?: string; bytes?: number; token?: string | null } = {}): Promise<Sent> {
  const headers: Record<string, string> = { "Content-Type": options.contentType ?? "audio/webm;codecs=opus" };
  if (options.token !== null) headers.Authorization = `Bearer ${options.token ?? DEVICE_TOKEN}`;
  const response = await realFetch(`http://127.0.0.1:${port}/api/v1/voice/transcriptions?${options.query ?? "workspaceId=w1"}`, {
    method: "POST",
    headers,
    body: Buffer.alloc(options.bytes ?? 2_048, 7),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    serverTiming: response.headers.get("server-timing"),
    retryAfter: response.headers.get("retry-after"),
  };
}

test("capabilities describe the configured instance so a client can hide the mic button", async () => {
  const response = await realFetch(`http://127.0.0.1:${port}/api/v1/voice/capabilities`, { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } });
  const body = await response.json() as { enabled: boolean; polish: boolean; maxBytes: number; maxDurationMs: number; mediaTypes: string[] };
  assert.equal(response.status, 200);
  assert.equal(body.enabled, true);
  assert.equal(body.polish, true);
  assert.equal(body.maxBytes, TEST_MAX_BYTES);
  assert.equal(body.maxDurationMs, 120_000);
  assert.ok(body.mediaTypes.includes("audio/webm"));
  assert.ok(body.mediaTypes.includes("audio/mp4"));
});

test("the whole surface needs a device token", async () => {
  const capabilities = await realFetch(`http://127.0.0.1:${port}/api/v1/voice/capabilities`);
  assert.equal(capabilities.status, 401);
  assert.equal((await dictate({ token: null })).status, 401);
});

test("a raw audio body comes back as cleaned text, with raw alongside it and the legs timed", async () => {
  const sent = await dictate({ query: "workspaceId=w1&peonId=p1&sessionId=s1&language=ru&durationMs=12000" });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.text, "Задеплой Kanat на прод.");
  assert.equal(sent.body.raw, "ну короче задеплой канат на прод");
  assert.equal(sent.body.polished, true);
  assert.equal(sent.body.language, "ru");
  assert.equal(sent.body.sttModel, "whisper-large-v3-turbo");
  assert.equal(sent.body.polishModel, "llama-3.3-70b-versatile");
  assert.equal(typeof sent.body.latencyMs, "number");
  assert.match(sent.serverTiming ?? "", /stt;dur=\d+, polish;dur=\d+, total;dur=\d+/);
});

test("a non-audio content type is rejected before anything is spent on it", async () => {
  const sent = await dictate({ contentType: "text/plain" });
  assert.equal(sent.status, 415);
  assert.equal(sent.body.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(sttCalls, 0);
});

test("an audio container the providers do not accept is rejected too", async () => {
  const sent = await dictate({ contentType: "audio/aiff" });
  assert.equal(sent.status, 415);
  assert.equal(sent.body.code, "UNSUPPORTED_MEDIA_TYPE");
  assert.equal(sttCalls, 0);
});

test("a body over the byte cap is refused by the router's own parser", async () => {
  const sent = await dictate({ bytes: TEST_MAX_BYTES + 1_024 });
  assert.equal(sent.status, 413);
  assert.equal(sent.body.code, "AUDIO_TOO_LARGE");
  assert.equal(sttCalls, 0);
});

test("a clip over the duration cap is refused even when its bytes fit", async () => {
  const sent = await dictate({ query: "workspaceId=w1&durationMs=180000" });
  assert.equal(sent.status, 413);
  assert.equal(sent.body.code, "AUDIO_TOO_LARGE");
  assert.equal(sttCalls, 0);
});

test("membership is the gate, not authentication — open sign-up makes that the whole point", async () => {
  const foreign = await dictate({ query: "workspaceId=w2" });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.body.code, "UNKNOWN_WORKSPACE");

  const missing = await dictate({ query: "language=ru" });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.code, "MISSING_WORKSPACE");
  assert.equal(sttCalls, 0);
});

test("a provider failure maps to a stable 502 without leaking the provider's body", async () => {
  const previous = sttResponse;
  sttResponse = () => new Response("upstream exploded: key gsk_secret", { status: 500 });
  const sent = await dictate();
  sttResponse = previous;
  assert.equal(sent.status, 502);
  assert.equal(sent.body.code, "VOICE_PROVIDER_ERROR");
  assert.equal(JSON.stringify(sent.body).includes("gsk_secret"), false);
});

test("an upstream rate limit is a 429 with the provider's own Retry-After, not a 502", async () => {
  const previous = sttResponse;
  sttResponse = () => new Response("rate limit reached for whisper-large-v3-turbo", {
    status: 429,
    headers: { "retry-after": "7.66" },
  });
  const sent = await dictate();
  sttResponse = previous;
  // Telling the client the instance is broken would have it retry immediately,
  // which is the worst possible response to being rate limited.
  assert.equal(sent.status, 429);
  assert.equal(sent.body.code, "VOICE_RATE_LIMITED");
  // Rounded up, so a client never retries a moment too early.
  assert.equal(sent.retryAfter, "8");
});

test("a genuine provider outage is still a 502", async () => {
  const previous = sttResponse;
  sttResponse = () => new Response("upstream exploded", { status: 503 });
  const sent = await dictate();
  sttResponse = previous;
  assert.equal(sent.status, 502);
  assert.equal(sent.body.code, "VOICE_PROVIDER_ERROR");
});

test("the instance-wide daily budget is enforced across users, not just per user", async () => {
  const previousVoice = config.voice;
  config.voice = { ...config.voice, requestsPerDay: 1 };
  const first = await dictate();
  const second = await dictate();
  config.voice = previousVoice;

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.body.code, "VOICE_RATE_LIMITED");
  assert.ok(Number(second.retryAfter) > 0);
});

test("empty speech is a 200 with an empty transcript, not an error", async () => {
  const previous = sttResponse;
  sttResponse = () => Response.json({ text: "" });
  const sent = await dictate();
  sttResponse = previous;
  assert.equal(sent.status, 200);
  assert.equal(sent.body.text, "");
  assert.equal(sent.body.polished, false);
});

test("a polish failure is never fatal — the raw transcript still arrives", async () => {
  const previous = polishResponse;
  polishResponse = () => new Response("busy", { status: 503 });
  const sent = await dictate();
  polishResponse = previous;
  assert.equal(sent.status, 200);
  assert.equal(sent.body.text, "ну короче задеплой канат на прод");
  assert.equal(sent.body.polished, false);
});

test("the per-user rate limit answers 429 with a stable code and Retry-After", async () => {
  const previousLimit = config.voice.requestsPerMinute;
  config.voice = { ...config.voice, requestsPerMinute: 1 };
  const first = await dictate();
  const second = await dictate();
  config.voice = { ...config.voice, requestsPerMinute: previousLimit };

  assert.equal(first.status, 200);
  assert.equal(second.status, 429);
  assert.equal(second.body.code, "VOICE_RATE_LIMITED");
  assert.ok(Number(second.retryAfter) > 0);
});

test("an instance with no provider configured says so instead of failing at the provider", async () => {
  const configured = config.voice;
  config.voice = { ...config.voice, stt: null };
  const sent = await dictate();
  const capabilities = await realFetch(`http://127.0.0.1:${port}/api/v1/voice/capabilities`, { headers: { Authorization: `Bearer ${DEVICE_TOKEN}` } });
  const body = await capabilities.json() as { enabled: boolean };
  config.voice = configured;

  assert.equal(sent.status, 503);
  assert.equal(sent.body.code, "VOICE_DISABLED");
  assert.equal(body.enabled, false);
});
