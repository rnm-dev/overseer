import assert from "node:assert/strict";
import test from "node:test";
import { resolveVoiceConfig } from "./voiceConfig.js";

// The wire contract is the configuration surface, so precedence between a
// preset row and the per-stage overrides is the thing most likely to be got
// wrong by a self-hoster — and the thing that must never silently half-work.

test("a preset name plus one key is the entire default configuration", () => {
  const voice = resolveVoiceConfig({ OVERSEER_VOICE: "groq", OVERSEER_VOICE_API_KEY: "gsk_test" });
  assert.equal(voice.preset, "groq");
  assert.deepEqual(voice.stt, { baseUrl: "https://api.groq.com/openai/v1", model: "whisper-large-v3-turbo", apiKey: "gsk_test" });
  assert.deepEqual(voice.polish, { baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.1-8b-instant", apiKey: "gsk_test" });
  assert.deepEqual(voice.warnings, []);
});

test("each stage overrides the preset independently and falls back to the shared key", () => {
  const voice = resolveVoiceConfig({
    OVERSEER_VOICE: "groq",
    OVERSEER_VOICE_API_KEY: "shared",
    OVERSEER_VOICE_STT_BASE_URL: "http://whisper.internal:8000/v1/",
    OVERSEER_VOICE_STT_MODEL: "Systran/faster-whisper-large-v3",
    OVERSEER_VOICE_POLISH_API_KEY: "polish-only",
  });
  assert.deepEqual(voice.stt, { baseUrl: "http://whisper.internal:8000/v1", model: "Systran/faster-whisper-large-v3", apiKey: "shared" });
  assert.equal(voice.polish?.baseUrl, "https://api.groq.com/openai/v1");
  assert.equal(voice.polish?.model, "llama-3.1-8b-instant");
  assert.equal(voice.polish?.apiKey, "polish-only");
});

test("a stage base URL with no preset means an OpenAI-compatible endpoint lives there", () => {
  const voice = resolveVoiceConfig({
    OVERSEER_VOICE_STT_BASE_URL: "http://127.0.0.1:8000/v1",
    OVERSEER_VOICE_STT_MODEL: "whisper-1",
  });
  assert.equal(voice.preset, null);
  assert.equal(voice.stt?.baseUrl, "http://127.0.0.1:8000/v1");
  // A plain-http endpoint is a local server, so no key is demanded of it.
  assert.equal(voice.stt?.apiKey, "");
  assert.equal(voice.polish, null);
  assert.equal(voice.warnings.some((w) => w.includes("returns the raw transcript")), true);
});

test("OVERSEER_VOICE_POLISH=off disables the stage deliberately, without a warning", () => {
  const voice = resolveVoiceConfig({ OVERSEER_VOICE: "groq", OVERSEER_VOICE_API_KEY: "k", OVERSEER_VOICE_POLISH: "off" });
  assert.equal(voice.polishDisabled, true);
  assert.equal(voice.polish, null);
  assert.ok(voice.stt);
  assert.deepEqual(voice.warnings, []);
});

test("an https stage with no key is treated as unconfigured, at boot rather than per request", () => {
  const voice = resolveVoiceConfig({ OVERSEER_VOICE: "groq" });
  assert.equal(voice.stt, null);
  assert.equal(voice.polish, null);
  assert.equal(voice.warnings.some((w) => w.includes("OVERSEER_VOICE_API_KEY")), true);
});

test("an unknown preset name warns and leaves dictation disabled", () => {
  const voice = resolveVoiceConfig({ OVERSEER_VOICE: "deepgram", OVERSEER_VOICE_API_KEY: "k" });
  assert.equal(voice.preset, null);
  assert.equal(voice.stt, null);
  assert.equal(voice.warnings.some((w) => w.includes("not a known preset")), true);
});

test("the local preset runs keyless and ships STT only", () => {
  const voice = resolveVoiceConfig({ OVERSEER_VOICE: "local" });
  assert.equal(voice.stt?.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(voice.polish, null);
  assert.equal(voice.polishDisabled, false);
});

test("a stage base URL with no model resolves to nothing and says which variable is missing", () => {
  const voice = resolveVoiceConfig({ OVERSEER_VOICE_STT_BASE_URL: "http://127.0.0.1:9000/v1" });
  assert.equal(voice.stt, null);
  assert.equal(voice.warnings.some((w) => w.includes("OVERSEER_VOICE_STT_MODEL")), true);
});

test("caps and quotas come from the environment with the documented defaults", () => {
  const defaults = resolveVoiceConfig({});
  assert.equal(defaults.maxDurationMs, 120_000);
  assert.equal(defaults.maxBytes, 4 * 1024 * 1024);
  assert.equal(defaults.minDurationMs, 300);
  assert.equal(defaults.polishTimeoutMs, 1_200);
  assert.equal(defaults.requestsPerMinute, 20);
  assert.equal(defaults.audioSecondsPerHour, 1_800);
  assert.equal(defaults.logTranscripts, false);

  const tuned = resolveVoiceConfig({ OVERSEER_VOICE_MAX_DURATION_MS: "60000", OVERSEER_VOICE_MAX_BYTES: "nonsense" });
  assert.equal(tuned.maxDurationMs, 60_000);
  assert.equal(tuned.maxBytes, 4 * 1024 * 1024);
});
