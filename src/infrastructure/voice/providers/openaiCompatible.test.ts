import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createSpeechToTextProvider, createTextPolishProvider } from "./openaiCompatible.js";
import { VoiceProviderError } from "../voiceTypes.js";

// The single adapter that every preset shares. What is asserted here is the
// wire shape a self-hoster's endpoint has to satisfy, so a change to it is a
// visible break rather than a silent one.

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

const SETTINGS = { baseUrl: "https://api.example/v1", model: "whisper-large-v3-turbo", apiKey: "key-123" };
const LIMITS = { maxBytes: 4_000_000, maxDurationMs: 120_000 };

interface Captured { url: string; init: RequestInit | undefined }

function captureFetch(response: Response): Captured {
  const captured: Captured = { url: "", init: undefined };
  globalThis.fetch = async (input, init) => {
    captured.url = String(input);
    captured.init = init;
    return response;
  };
  return captured;
}

test("transcription posts multipart file/model/prompt and reads text back", async () => {
  const captured = captureFetch(Response.json({ text: " задеплой Kanat ", language: "ru" }));
  const provider = createSpeechToTextProvider(SETTINGS, LIMITS);

  const result = await provider.transcribe({
    audio: Buffer.from("fake-opus-bytes"),
    mediaType: "audio/webm;codecs=opus",
    language: "ru",
    biasPrompt: "Kanat, Overseer, Peon",
    signal: AbortSignal.timeout(1_000),
  });

  assert.equal(captured.url, "https://api.example/v1/audio/transcriptions");
  assert.equal(new Headers(captured.init?.headers).get("authorization"), "Bearer key-123");
  const form = captured.init?.body as FormData;
  assert.ok(form instanceof FormData);
  assert.equal(form.get("model"), "whisper-large-v3-turbo");
  assert.equal(form.get("language"), "ru");
  assert.equal(form.get("prompt"), "Kanat, Overseer, Peon");
  assert.equal(form.get("response_format"), "json");
  // Whisper-family APIs infer the container from the filename, not the part's
  // content type, so the extension has to follow what the client recorded.
  const file = form.get("file") as File;
  assert.equal(file.name, "dictation.webm");
  assert.equal(await file.text(), "fake-opus-bytes");

  assert.equal(result.text, " задеплой Kanat ");
  assert.equal(result.language, "ru");
  assert.equal(result.model, "whisper-large-v3-turbo");
});

test("an mp4 recording from Safari or the Flutter recorder is named for its container", async () => {
  const captured = captureFetch(Response.json({ text: "hello" }));
  await createSpeechToTextProvider(SETTINGS, LIMITS).transcribe({
    audio: Buffer.from("aac"), mediaType: "audio/mp4", signal: AbortSignal.timeout(1_000),
  });
  assert.equal((( captured.init?.body as FormData).get("file") as File).name, "dictation.m4a");
});

test("a keyless local endpoint sends no Authorization header", async () => {
  const captured = captureFetch(Response.json({ text: "local" }));
  await createSpeechToTextProvider({ baseUrl: "http://127.0.0.1:8000/v1", model: "whisper-1", apiKey: "" }, LIMITS)
    .transcribe({ audio: Buffer.from("x"), mediaType: "audio/webm", signal: AbortSignal.timeout(1_000) });
  assert.equal(new Headers(captured.init?.headers).get("authorization"), null);
});

test("a provider HTTP failure becomes a VoiceProviderError carrying the stage and status", async () => {
  captureFetch(new Response("rate limit reached for whisper-large-v3-turbo", { status: 429 }));
  await assert.rejects(
    createSpeechToTextProvider(SETTINGS, LIMITS).transcribe({ audio: Buffer.from("x"), mediaType: "audio/webm", signal: AbortSignal.timeout(1_000) }),
    (error: unknown) => error instanceof VoiceProviderError && error.stage === "stt" && error.status === 429,
  );
});

test("a transport failure becomes a VoiceProviderError rather than escaping raw", async () => {
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(
    createSpeechToTextProvider(SETTINGS, LIMITS).transcribe({ audio: Buffer.from("x"), mediaType: "audio/webm", signal: AbortSignal.timeout(1_000) }),
    (error: unknown) => error instanceof VoiceProviderError && error.stage === "stt" && error.status === null,
  );
});

test("a response with no text field is a provider error, not an empty transcript", async () => {
  captureFetch(Response.json({ unexpected: true }));
  await assert.rejects(
    createSpeechToTextProvider(SETTINGS, LIMITS).transcribe({ audio: Buffer.from("x"), mediaType: "audio/webm", signal: AbortSignal.timeout(1_000) }),
    (error: unknown) => error instanceof VoiceProviderError,
  );
});

test("an unconfigured stage refuses rather than calling out to nowhere", async () => {
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  await assert.rejects(
    createSpeechToTextProvider(null, LIMITS).transcribe({ audio: Buffer.from("x"), mediaType: "audio/webm", signal: AbortSignal.timeout(1_000) }),
    (error: unknown) => error instanceof VoiceProviderError,
  );
  assert.equal(createSpeechToTextProvider(null, LIMITS).isConfigured(), false);
  assert.equal(createTextPolishProvider(null).isConfigured(), false);
});

test("polish is an ordinary chat completion, with the glossary and draft as context", async () => {
  const captured = captureFetch(Response.json({ choices: [{ message: { content: "Задеплой Kanat на прод." } }] }));
  const result = await createTextPolishProvider({ ...SETTINGS, model: "llama-3.1-8b-instant" }).polish({
    raw: "ну короче задеплой канат на прод",
    glossary: ["Kanat", "kamal-proxy"],
    locale: "ru",
    draft: "already typed",
    signal: AbortSignal.timeout(1_000),
  });

  assert.equal(captured.url, "https://api.example/v1/chat/completions");
  const body = JSON.parse(String(captured.init?.body)) as { model: string; temperature: number; messages: Array<{ role: string; content: string }> };
  assert.equal(body.model, "llama-3.1-8b-instant");
  assert.equal(body.temperature, 0);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /never translate/i);
  assert.match(body.messages[1].content, /Kanat, kamal-proxy/);
  assert.match(body.messages[1].content, /already typed/);
  assert.match(body.messages[1].content, /ну короче задеплой канат на прод/);
  assert.equal(result.text, "Задеплой Kanat на прод.");
});

test("a polish response with no message content is a provider error the pipeline can absorb", async () => {
  captureFetch(Response.json({ choices: [] }));
  await assert.rejects(
    createTextPolishProvider(SETTINGS).polish({ raw: "x", signal: AbortSignal.timeout(1_000) }),
    (error: unknown) => error instanceof VoiceProviderError && error.stage === "polish",
  );
});
