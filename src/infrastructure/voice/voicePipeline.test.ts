import assert from "node:assert/strict";
import test from "node:test";
import { runVoicePipeline, stripPolishWrapper, type VoicePipelineDeps } from "./voicePipeline.js";
import { VoiceProviderError, type SpeechToTextProvider, type TextPolishProvider } from "./voiceTypes.js";

// The whole pipeline is exercised with fake providers and no network — the
// point of the seam. Everything asserted here is a rule about *not trusting*
// the correction model: it may answer the prompt, wrap its output, stall, or
// invent speech out of silence, and none of that may reach the composer.

const AUDIO = Buffer.alloc(48_000, 1);

function fakeStt(text: string, extra: { language?: string; fail?: boolean } = {}): SpeechToTextProvider {
  return {
    id: "fake-stt",
    limits: { maxBytes: 4_000_000, maxDurationMs: 120_000, mediaTypes: ["audio/webm"] },
    isConfigured: () => true,
    transcribe: async () => {
      if (extra.fail) throw new VoiceProviderError("stt", "boom", 500);
      return { text, language: extra.language, model: "fake-whisper" };
    },
  };
}

function fakePolish(behaviour: (raw: string) => string | Promise<string>): TextPolishProvider {
  return {
    id: "fake-polish",
    isConfigured: () => true,
    polish: async (input) => ({ text: await behaviour(input.raw), model: "fake-polisher" }),
  };
}

// A provider that never answers, and honours the signal when told to stop.
const hangingPolish: TextPolishProvider = {
  id: "hanging-polish",
  isConfigured: () => true,
  polish: (input) => new Promise((_resolve, reject) => {
    input.signal.addEventListener("abort", () => reject(input.signal.reason));
  }),
};

// The worse case: a provider that ignores the signal entirely. The response
// must not wait on it either.
const deafPolish: TextPolishProvider = {
  id: "deaf-polish",
  isConfigured: () => true,
  polish: () => new Promise(() => {}),
};

function deps(stt: SpeechToTextProvider, polish: TextPolishProvider | null, overrides: Partial<VoicePipelineDeps> = {}): VoicePipelineDeps {
  return { stt, polish, sttTimeoutMs: 1_000, polishTimeoutMs: 50, minDurationMs: 300, ...overrides };
}

test("a clean polish replaces the transcript and raw still travels alongside it", async () => {
  const result = await runVoicePipeline(
    { audio: AUDIO, mediaType: "audio/webm", durationMs: 12_000 },
    deps(fakeStt("ну короче задеплой канат на прод", { language: "ru" }), fakePolish(() => "Задеплой Kanat на прод.")),
  );
  assert.equal(result.text, "Задеплой Kanat на прод.");
  assert.equal(result.raw, "ну короче задеплой канат на прод");
  assert.equal(result.polished, true);
  assert.equal(result.language, "ru");
  assert.equal(result.polishModel, "fake-polisher");
  assert.equal(result.guardrail, null);
});

test("a polish that answers the prompt instead of cleaning it is discarded on the growth ratio", async () => {
  const raw = "restart the postgres container";
  const answer = "Sure! To restart the Postgres container you should run docker compose restart postgres, then check the logs with docker compose logs -f postgres to confirm it came back healthy.";
  const result = await runVoicePipeline({ audio: AUDIO, mediaType: "audio/webm" }, deps(fakeStt(raw), fakePolish(() => answer)));
  assert.equal(result.text, raw);
  assert.equal(result.polished, false);
  assert.equal(result.guardrail, "length-ratio");
});

test("a polish that summarises away most of the utterance is discarded on the shrink ratio", async () => {
  const raw = "okay so what I want you to do is take the voice branch and rebase it onto master and then run the verify gate";
  const result = await runVoicePipeline({ audio: AUDIO, mediaType: "audio/webm" }, deps(fakeStt(raw), fakePolish(() => "Rebase and verify.")));
  assert.equal(result.text, raw);
  assert.equal(result.polished, false);
  assert.equal(result.guardrail, "length-ratio");
});

test("a polish timeout falls back to the raw transcript rather than failing the request", async () => {
  const result = await runVoicePipeline(
    { audio: AUDIO, mediaType: "audio/webm" },
    deps(fakeStt("deploy the fleet"), hangingPolish, { polishTimeoutMs: 20 }),
  );
  assert.equal(result.text, "deploy the fleet");
  assert.equal(result.polished, false);
  assert.equal(result.guardrail, "polish-timeout");
});

test("a provider that ignores the abort signal still cannot hold the response open", async () => {
  const startedAt = Date.now();
  const result = await runVoicePipeline(
    { audio: AUDIO, mediaType: "audio/webm" },
    deps(fakeStt("deploy the fleet"), deafPolish, { polishTimeoutMs: 20 }),
  );
  assert.equal(result.text, "deploy the fleet");
  assert.equal(result.guardrail, "polish-timeout");
  assert.ok(Date.now() - startedAt < 1_000);
});

test("a polish provider error is never fatal", async () => {
  const failing: TextPolishProvider = {
    id: "broken", isConfigured: () => true,
    polish: async () => { throw new VoiceProviderError("polish", "502 from provider", 502); },
  };
  const result = await runVoicePipeline({ audio: AUDIO, mediaType: "audio/webm" }, deps(fakeStt("pause the fleet"), failing));
  assert.equal(result.text, "pause the fleet");
  assert.equal(result.guardrail, "polish-error");
});

test("an STT failure is fatal — there is nothing to fall back to", async () => {
  await assert.rejects(
    runVoicePipeline({ audio: AUDIO, mediaType: "audio/webm" }, deps(fakeStt("", { fail: true }), null)),
    (error: unknown) => error instanceof VoiceProviderError && error.stage === "stt",
  );
});

test("with no polish provider the raw transcript is returned unchanged", async () => {
  const result = await runVoicePipeline({ audio: AUDIO, mediaType: "audio/webm" }, deps(fakeStt("raw only"), null));
  assert.equal(result.text, "raw only");
  assert.equal(result.polished, false);
  assert.equal(result.guardrail, "polish-unconfigured");
});

test("audio shorter than the minimum never reaches the provider", async () => {
  const exploding: SpeechToTextProvider = {
    ...fakeStt(""),
    transcribe: async () => { throw new Error("must not be called"); },
  };
  const result = await runVoicePipeline({ audio: Buffer.alloc(200), mediaType: "audio/webm", durationMs: 120 }, deps(exploding, null));
  assert.equal(result.text, "");
  assert.equal(result.emptySpeech, true);
});

test("a stock hallucination on near-silent audio is reported as empty speech", async () => {
  const result = await runVoicePipeline(
    { audio: Buffer.alloc(2_000), mediaType: "audio/webm", durationMs: 600 },
    deps(fakeStt("Thank you."), fakePolish(() => "must not be called")),
  );
  assert.equal(result.text, "");
  assert.equal(result.raw, "");
  assert.equal(result.emptySpeech, true);
});

test("the same phrase spoken deliberately in a long clip survives", async () => {
  const result = await runVoicePipeline(
    { audio: AUDIO, mediaType: "audio/webm", durationMs: 9_000 },
    deps(fakeStt("Thank you."), null),
  );
  assert.equal(result.text, "Thank you.");
  assert.equal(result.emptySpeech, false);
});

test("an empty transcript is empty speech, not an error", async () => {
  const result = await runVoicePipeline({ audio: AUDIO, mediaType: "audio/webm" }, deps(fakeStt("   "), null));
  assert.equal(result.text, "");
  assert.equal(result.emptySpeech, true);
});

test("wrapping quotes and code fences are stripped before the ratio is judged", () => {
  assert.equal(stripPolishWrapper('"Deploy the fleet."'), "Deploy the fleet.");
  assert.equal(stripPolishWrapper("```\nDeploy the fleet.\n```"), "Deploy the fleet.");
  assert.equal(stripPolishWrapper("```text\nDeploy the fleet.\n```"), "Deploy the fleet.");
  assert.equal(stripPolishWrapper("«Задеплой флот.»"), "Задеплой флот.");
  assert.equal(stripPolishWrapper('He said "hello" to me'), 'He said "hello" to me');
});

test("a stripped wrapper does not cost an otherwise good polish", async () => {
  const result = await runVoicePipeline(
    { audio: AUDIO, mediaType: "audio/webm" },
    deps(fakeStt("deploy the fleet"), fakePolish(() => '```\n"Deploy the fleet."\n```')),
  );
  assert.equal(result.text, "Deploy the fleet.");
  assert.equal(result.polished, true);
});
