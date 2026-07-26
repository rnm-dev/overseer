import { config } from "../../config.js";
import { createSpeechToTextProvider, createTextPolishProvider } from "./providers/openaiCompatible.js";
import { runVoicePipeline, type VoicePipelineInput, type VoicePipelineResult } from "./voicePipeline.js";
import { VOICE_MEDIA_TYPES } from "./voiceMedia.js";
import type { SpeechToTextProvider, TextPolishProvider } from "./voiceTypes.js";

// The public face of the voice infrastructure: which providers a given
// environment resolves to, what the client is allowed to send, and one call
// that runs audio through the whole pipeline.
//
// Providers are constructed per call rather than memoised at import time —
// they are two closures over a settings row, and building them fresh keeps
// tests (and a future config reload) from reading a stale snapshot.

export * from "./voiceTypes.js";
export * from "./voicePipeline.js";
export { VOICE_MEDIA_TYPES, isSupportedMediaType, normalizeMediaType } from "./voiceMedia.js";
export { VOICE_PRESETS, VOICE_PRESET_NAMES, type VoicePreset } from "./voicePresets.js";
export { resolveVoiceConfig, type VoiceConfig, type VoiceStageSettings } from "./voiceConfig.js";

export interface VoiceCapabilities {
  enabled: boolean;
  maxDurationMs: number;
  maxBytes: number;
  mediaTypes: string[];
  polish: boolean;
}

function speechToText(): SpeechToTextProvider {
  return createSpeechToTextProvider(config.voice.stt, {
    maxBytes: config.voice.maxBytes,
    maxDurationMs: config.voice.maxDurationMs,
  });
}

function textPolish(): TextPolishProvider | null {
  if (!config.voice.polish) return null;
  return createTextPolishProvider(config.voice.polish);
}

// Dictation is enabled exactly when transcription is. Polish is an optional
// quality stage on top, never a precondition.
export function voiceEnabled(): boolean {
  return speechToText().isConfigured();
}

export function voiceCapabilities(): VoiceCapabilities {
  return {
    enabled: voiceEnabled(),
    maxDurationMs: config.voice.maxDurationMs,
    maxBytes: config.voice.maxBytes,
    mediaTypes: VOICE_MEDIA_TYPES,
    polish: textPolish() !== null,
  };
}

export async function transcribeVoice(input: VoicePipelineInput): Promise<VoicePipelineResult> {
  return runVoicePipeline(input, {
    stt: speechToText(),
    polish: textPolish(),
    sttTimeoutMs: config.voice.sttTimeoutMs,
    polishTimeoutMs: config.voice.polishTimeoutMs,
    minDurationMs: config.voice.minDurationMs,
  });
}
