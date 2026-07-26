import type { SpeechToTextProvider, TextPolishProvider } from "./voiceTypes.js";

// stt → guardrails → polish. The pipeline's contract with the client is that
// `raw` always travels alongside `text`: the UI can fall back, and a quality
// regression stays diagnosable without ever logging audio or storing speech.
//
// Polish failure is never fatal. Every path below that cannot produce trusted
// corrected text returns the raw transcript with `polished: false` and a reason
// the caller can count — the guardrail trip rate is one of the few quality
// signals available when transcripts are not kept.

export type VoiceGuardrail =
  | "polish-disabled"
  | "polish-unconfigured"
  | "polish-timeout"
  | "polish-error"
  | "polish-empty"
  | "length-ratio";

export interface VoicePipelineResult {
  text: string;
  raw: string;
  polished: boolean;
  language: string | null;
  sttModel: string | null;
  polishModel: string | null;
  sttMs: number;
  polishMs: number;
  guardrail: VoiceGuardrail | null;
  emptySpeech: boolean;
}

export interface VoicePipelineInput {
  audio: Buffer;
  mediaType: string;
  durationMs?: number;
  language?: string;
  glossary?: string[];
  biasPrompt?: string;
  draft?: string;
}

export interface VoicePipelineDeps {
  stt: SpeechToTextProvider;
  polish: TextPolishProvider | null;
  sttTimeoutMs: number;
  polishTimeoutMs: number;
  minDurationMs: number;
}

// The pipeline owns its deadlines rather than delegating them. A provider that
// honours the signal tears down its own socket, which is what we want; but a
// provider that ignores it — a third-party adapter, a wrapper with a bug — must
// still not be able to hang the request, and "polish never blocks the response"
// has to hold by construction, not by provider goodwill.
function withDeadline<T>(run: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const attempt = run(controller.signal);
  // The deadline may win the race, leaving this promise to settle into nothing.
  // Swallow that so a late failure is not an unhandled rejection.
  attempt.catch(() => {});
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      const error = new Error(`provider call exceeded ${ms}ms`);
      error.name = "TimeoutError";
      reject(error);
    }, ms);
  });
  return Promise.race([attempt, deadline]).finally(() => clearTimeout(timer));
}

// The polished text may not grow past ~1.6x or shrink past ~0.5x the raw
// transcript. A correction pass changes punctuation and drops fillers; anything
// outside this band is the model answering, summarising or truncating.
const MAX_GROWTH_RATIO = 1.6;
const MIN_SHRINK_RATIO = 0.5;

// Whisper-family models emit confident stock phrases when handed near-silence:
// YouTube subtitle credits, "Thank you." and friends. Only applied to a short
// result from short audio, so a genuine two-word utterance survives.
const HALLUCINATION_PHRASES = new Set([
  "you",
  "thank you",
  "thanks",
  "thanks for watching",
  "thank you for watching",
  "thank you very much",
  "bye",
  "please subscribe",
  "спасибо",
  "спасибо за просмотр",
  "продолжение следует",
  "субтитры сделал dimatorzok",
  "субтитры создавал dimatorzok",
  "редактор субтитров а.семкин корректор а.егорова",
  "с вами был dimatorzok",
]);
const SHORT_RESULT_CHARS = 40;
const SHORT_AUDIO_MS = 2_500;
const SHORT_AUDIO_BYTES = 12_000;

function normalizeForBlocklist(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,!?;:"'`)(\][…—–-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelySilenceHallucination(text: string, durationMs: number | undefined, byteLength: number): boolean {
  if (text.length > SHORT_RESULT_CHARS) return false;
  const shortAudio = durationMs === undefined ? byteLength <= SHORT_AUDIO_BYTES : durationMs <= SHORT_AUDIO_MS;
  if (!shortAudio) return false;
  return HALLUCINATION_PHRASES.has(normalizeForBlocklist(text));
}

// A correction model likes to wrap its answer in quotes or a code fence even
// when told not to. Strip that wrapper before the ratio check, so formatting
// noise does not cost us an otherwise good polish.
export function stripPolishWrapper(text: string): string {
  let value = text.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(value);
  if (fence) value = fence[1].trim();
  for (const [open, close] of [['"', '"'], ["'", "'"], ["«", "»"], ["“", "”"], ["`", "`"]]) {
    if (value.length >= 2 && value.startsWith(open) && value.endsWith(close)) {
      value = value.slice(1, -1).trim();
    }
  }
  return value;
}

export function polishWithinRatio(raw: string, polished: string): boolean {
  const rawLength = raw.trim().length;
  if (rawLength === 0) return false;
  const ratio = polished.trim().length / rawLength;
  return ratio <= MAX_GROWTH_RATIO && ratio >= MIN_SHRINK_RATIO;
}

function empty(result: Partial<VoicePipelineResult> = {}): VoicePipelineResult {
  return {
    text: "",
    raw: "",
    polished: false,
    language: null,
    sttModel: null,
    polishModel: null,
    sttMs: 0,
    polishMs: 0,
    guardrail: null,
    emptySpeech: true,
    ...result,
  };
}

export async function runVoicePipeline(input: VoicePipelineInput, deps: VoicePipelineDeps): Promise<VoicePipelineResult> {
  // Too short to contain speech. Answering 200 with an empty transcript rather
  // than an error keeps the client's "nothing was said" path identical to the
  // one an actually-silent clip takes, and spends no provider call on it.
  if (input.durationMs !== undefined && input.durationMs < deps.minDurationMs) return empty();

  const sttStartedAt = Date.now();
  const transcript = await withDeadline(
    (signal) =>
      deps.stt.transcribe({
        audio: input.audio,
        mediaType: input.mediaType,
        language: input.language,
        biasPrompt: input.biasPrompt,
        signal,
      }),
    deps.sttTimeoutMs,
  );
  const sttMs = Date.now() - sttStartedAt;

  const raw = transcript.text.trim();
  const language = transcript.language ?? input.language ?? null;
  if (!raw || isLikelySilenceHallucination(raw, input.durationMs, input.audio.byteLength)) {
    return empty({ sttModel: transcript.model, language, sttMs });
  }

  const base: VoicePipelineResult = {
    text: raw,
    raw,
    polished: false,
    language,
    sttModel: transcript.model,
    polishModel: null,
    sttMs,
    polishMs: 0,
    guardrail: null,
    emptySpeech: false,
  };

  if (!deps.polish) return { ...base, guardrail: "polish-unconfigured" };

  const polishStartedAt = Date.now();
  let candidate: { text: string; model: string };
  try {
    candidate = await withDeadline(
      (signal) =>
        deps.polish!.polish({
          raw,
          glossary: input.glossary,
          locale: input.language,
          draft: input.draft,
          signal,
        }),
      deps.polishTimeoutMs,
    );
  } catch (cause) {
    const timedOut = cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
    return { ...base, polishMs: Date.now() - polishStartedAt, guardrail: timedOut ? "polish-timeout" : "polish-error" };
  }
  const polishMs = Date.now() - polishStartedAt;

  const cleaned = stripPolishWrapper(candidate.text);
  if (!cleaned) return { ...base, polishMs, polishModel: candidate.model, guardrail: "polish-empty" };
  if (!polishWithinRatio(raw, cleaned)) return { ...base, polishMs, polishModel: candidate.model, guardrail: "length-ratio" };

  return { ...base, text: cleaned, polished: true, polishMs, polishModel: candidate.model };
}
