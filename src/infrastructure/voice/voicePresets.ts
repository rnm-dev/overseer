// Vendor names are data, not classes.
//
// The whole point of the configuration model: every backend below speaks the
// OpenAI audio + chat wire shapes, so a vendor name resolves to nothing but a
// row here. Adding a backend is a one-line data PR — trivial to review, and
// impossible to break the others.
//
// `polishModel: null` means the preset ships no correction model (a bare STT
// server has none); the stage stays unconfigured and the pipeline returns the
// raw transcript until OVERSEER_VOICE_POLISH_MODEL points somewhere.
export interface VoicePreset {
  baseUrl: string;
  sttModel: string;
  polishModel: string | null;
}

export const VOICE_PRESETS: Record<string, VoicePreset> = {
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    sttModel: "whisper-large-v3-turbo",
    polishModel: "llama-3.3-70b-versatile",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    sttModel: "whisper-1",
    polishModel: "gpt-4o-mini",
  },
  // A self-hosted faster-whisper / speaches / whisper.cpp server. STT only:
  // point OVERSEER_VOICE_POLISH_BASE_URL/MODEL at a local LLM to add polish.
  local: {
    baseUrl: "http://127.0.0.1:8000/v1",
    sttModel: "Systran/faster-whisper-large-v3",
    polishModel: null,
  },
};

export const VOICE_PRESET_NAMES = Object.keys(VOICE_PRESETS);
