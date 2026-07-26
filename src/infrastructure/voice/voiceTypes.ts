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

  constructor(stage: "stt" | "polish", message: string, status: number | null = null) {
    super(message);
    this.name = "VoiceProviderError";
    this.stage = stage;
    this.status = status;
  }
}
