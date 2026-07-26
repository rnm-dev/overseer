// The provider seam. Both interfaces are deliberately one method wide: a
// third-party adapter is ~40 lines, and adding a backend never touches the
// pipeline, the route, or each other.
//
// Stage one turns audio into text. Stage two cleans that text up. They are
// independent because the interesting quality knob is the second one.

export interface SpeechToTextLimits {
  maxBytes: number;
  maxDurationMs: number;
  mediaTypes: string[];
}

export interface TranscribeInput {
  audio: Buffer;
  mediaType: string; // exactly what the client recorded
  language?: string; // BCP-47 hint, or undefined = auto-detect
  biasPrompt?: string; // <=224 tokens for Whisper-family APIs
  signal: AbortSignal;
}

export interface TranscribeResult {
  text: string;
  language?: string;
  // The provider's own measure of the audio it decoded. Unlike the client's
  // declared duration this cannot be understated, so it is what gets logged.
  durationSeconds?: number;
  model: string;
}

export interface SpeechToTextProvider {
  readonly id: string; // "openai-compatible", a preset name, …
  readonly limits: SpeechToTextLimits;
  isConfigured(): boolean; // drives capabilities + config warnings
  transcribe(input: TranscribeInput): Promise<TranscribeResult>;
}

export interface PolishInput {
  raw: string;
  glossary?: string[];
  locale?: string;
  draft?: string; // text already in the composer
  signal: AbortSignal;
}

export interface PolishResult {
  text: string;
  model: string;
}

export interface TextPolishProvider {
  readonly id: string;
  isConfigured(): boolean;
  polish(input: PolishInput): Promise<PolishResult>;
}

// A provider stage failed in a way the caller cannot recover from. Only the STT
// stage propagates this to the client (502 VOICE_PROVIDER_ERROR); a polish
// failure is swallowed by the pipeline and the raw transcript is returned.
export class VoiceProviderError extends Error {
  readonly stage: "stt" | "polish";
  readonly status: number | null;
  // The provider's own Retry-After, when it sends one. A 429 from upstream is a
  // rate limit, not an outage, and the caller needs to know how long to wait.
  readonly retryAfterSeconds: number | null;

  constructor(stage: "stt" | "polish", message: string, status: number | null = null, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "VoiceProviderError";
    this.stage = stage;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// Retry-After is either a delta in seconds or an HTTP date. Groq sends seconds,
// often fractional; round up so a client never retries a moment too early.
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds)) return Math.max(1, Math.ceil(seconds));
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - Date.now()) / 1_000)) : null;
}
