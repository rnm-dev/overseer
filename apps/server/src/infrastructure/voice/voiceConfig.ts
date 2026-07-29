import { VOICE_PRESETS, VOICE_PRESET_NAMES } from "./voicePresets.js";

// Env → resolved voice settings. Pure: it takes the environment as an argument
// and imports nothing but the preset table, so config.ts can own the wiring
// without infrastructure and config depending on each other in a cycle, and so
// precedence is testable without touching process.env.
//
//   OVERSEER_VOICE=groq + OVERSEER_VOICE_API_KEY=…    the entire default config
//   OVERSEER_VOICE_{STT,POLISH}_{BASE_URL,MODEL,API_KEY}   per-stage overrides
//
// A stage BASE_URL with no preset named means "an OpenAI-compatible endpoint
// lives here" — the bare-endpoint configuration, available without being the
// only option.

export interface VoiceStageSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface VoiceConfig {
  preset: string | null;
  stt: VoiceStageSettings | null; // null = not configured; dictation is off
  polish: VoiceStageSettings | null; // null = not configured or explicitly off
  polishDisabled: boolean; // OVERSEER_VOICE_POLISH=off — deliberate, not a warning
  maxDurationMs: number;
  minDurationMs: number;
  maxBytes: number;
  sttTimeoutMs: number;
  polishTimeoutMs: number;
  requestsPerMinute: number;
  audioSecondsPerHour: number;
  requestsPerDay: number;
  logTranscripts: boolean;
  warnings: string[];
}

const OFF_VALUES = new Set(["off", "0", "false", "none", "no", "disabled"]);

function trimmed(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = trimmed(env, name);
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Unlike num(), 0 is meaningful here: it means "no ceiling configured".
function countOrZero(env: NodeJS.ProcessEnv, name: string): number {
  const raw = trimmed(env, name);
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

// An https endpoint is assumed to be a hosted vendor that needs a key; a plain
// http one is assumed to be a local or tailnet server that does not. This keeps
// `local` usable with no key while still catching the common misconfiguration —
// OVERSEER_VOICE=groq with the key forgotten — at boot rather than at request
// time.
function requiresApiKey(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === "https:";
  } catch {
    return true;
  }
}

interface StageResolution {
  settings: VoiceStageSettings | null;
  warnings: string[];
}

function resolveStage(
  env: NodeJS.ProcessEnv,
  stage: "STT" | "POLISH",
  presetBaseUrl: string | null,
  presetModel: string | null,
  sharedKey: string,
): StageResolution {
  const baseUrl = normalizeBaseUrl(trimmed(env, `OVERSEER_VOICE_${stage}_BASE_URL`) || (presetBaseUrl ?? ""));
  const model = trimmed(env, `OVERSEER_VOICE_${stage}_MODEL`) || (presetModel ?? "");
  const apiKey = trimmed(env, `OVERSEER_VOICE_${stage}_API_KEY`) || sharedKey;
  const label = stage.toLowerCase();

  if (!baseUrl && !model) return { settings: null, warnings: [] };
  if (!baseUrl) {
    return { settings: null, warnings: [`OVERSEER_VOICE_${stage}_MODEL is set but no base URL resolves for the ${label} stage — name a preset in OVERSEER_VOICE or set OVERSEER_VOICE_${stage}_BASE_URL.`] };
  }
  if (!model) {
    return { settings: null, warnings: [`OVERSEER_VOICE_${stage}_BASE_URL is set but no model resolves for the ${label} stage — set OVERSEER_VOICE_${stage}_MODEL.`] };
  }
  if (!apiKey && requiresApiKey(baseUrl)) {
    return { settings: null, warnings: [`the voice ${label} stage points at ${baseUrl} but no API key is set — set OVERSEER_VOICE_API_KEY (or OVERSEER_VOICE_${stage}_API_KEY).`] };
  }
  return { settings: { baseUrl, model, apiKey }, warnings: [] };
}

export function resolveVoiceConfig(env: NodeJS.ProcessEnv): VoiceConfig {
  const warnings: string[] = [];
  const requested = trimmed(env, "OVERSEER_VOICE");
  let preset: string | null = null;
  if (requested && !OFF_VALUES.has(requested.toLowerCase())) {
    if (VOICE_PRESETS[requested.toLowerCase()]) preset = requested.toLowerCase();
    else warnings.push(`OVERSEER_VOICE="${requested}" is not a known preset (${VOICE_PRESET_NAMES.join(", ")}) — voice dictation stays disabled unless the per-stage base URLs are set.`);
  }
  const row = preset ? VOICE_PRESETS[preset] : null;
  const sharedKey = trimmed(env, "OVERSEER_VOICE_API_KEY");

  const rawPolishMode = trimmed(env, "OVERSEER_VOICE_POLISH");
  const polishDisabled = OFF_VALUES.has(rawPolishMode.toLowerCase());
  if (rawPolishMode && !polishDisabled) {
    warnings.push(`OVERSEER_VOICE_POLISH="${rawPolishMode}" is not understood — the only supported value is "off". Use OVERSEER_VOICE_POLISH_MODEL to choose a correction model.`);
  }

  const stt = resolveStage(env, "STT", row?.baseUrl ?? null, row?.sttModel ?? null, sharedKey);
  warnings.push(...stt.warnings);

  const polish = polishDisabled
    ? { settings: null, warnings: [] as string[] }
    : resolveStage(env, "POLISH", row?.baseUrl ?? null, row?.polishModel ?? null, sharedKey);
  warnings.push(...polish.warnings);

  if (stt.settings && countOrZero(env, "OVERSEER_VOICE_REQUESTS_PER_DAY") === 0) {
    warnings.push("OVERSEER_VOICE_REQUESTS_PER_DAY is not set — nothing caps the instance's total daily provider spend, so one busy user can exhaust it for everyone. Set it to match your provider tier's daily request limit.");
  }
  if (stt.settings && !polish.settings && !polishDisabled) {
    warnings.push("no voice polish model resolves — dictation returns the raw transcript. Set OVERSEER_VOICE_POLISH_MODEL, or OVERSEER_VOICE_POLISH=off to make that deliberate.");
  }

  return {
    preset,
    stt: stt.settings,
    polish: polish.settings,
    polishDisabled,
    // Sized for chat-style utterances, not lectures. 120 s of Opus is ~400 KB,
    // so the byte cap is headroom for higher-bitrate or AAC recordings rather
    // than a real constraint.
    maxDurationMs: num(env, "OVERSEER_VOICE_MAX_DURATION_MS", 120_000),
    minDurationMs: num(env, "OVERSEER_VOICE_MIN_DURATION_MS", 300),
    maxBytes: num(env, "OVERSEER_VOICE_MAX_BYTES", 4 * 1024 * 1024),
    sttTimeoutMs: num(env, "OVERSEER_VOICE_STT_TIMEOUT_MS", 20_000),
    polishTimeoutMs: num(env, "OVERSEER_VOICE_POLISH_TIMEOUT_MS", 1_200),
    requestsPerMinute: num(env, "OVERSEER_VOICE_REQUESTS_PER_MINUTE", 20),
    audioSecondsPerHour: num(env, "OVERSEER_VOICE_AUDIO_SECONDS_PER_HOUR", 1_800),
    // Deliberately unset by default. Only the operator knows their provider
    // tier, and silently capping a paid account at some guessed number would be
    // worse than the warning below.
    requestsPerDay: countOrZero(env, "OVERSEER_VOICE_REQUESTS_PER_DAY"),
    // Audio is never persisted and transcripts are never logged. This flag is
    // for pointing a dev instance at your own dictation while tuning.
    logTranscripts: trimmed(env, "OVERSEER_VOICE_DEBUG_TRANSCRIPTS") === "1",
    warnings,
  };
}
