import express from "express";
import { config } from "../config.js";
import {
  isSupportedMediaType,
  normalizeMediaType,
  transcribeVoice,
  voiceCapabilities,
  voiceEnabled,
  VoiceProviderError,
  type VoicePipelineResult,
} from "../infrastructure/voice/index.js";
import { authorizeDictation } from "../modules/voice/index.js";
import { userOf } from "./helpers.js";

// Dictation: audio in, cleaned text out.
//
// The body is raw audio, not multipart. The app has three runtime dependencies
// and no multipart parser; adding one for a single route is not worth it, so
// the codec rides in Content-Type and the ids ride in the query string:
//
//   POST /api/v1/voice/transcriptions?workspaceId=…&peonId=…&sessionId=…&language=ru
//   Content-Type: audio/webm;codecs=opus
//   <binary>
//
// express.raw is mounted on THIS router only. The global express.json({ limit:
// "1mb" }) stays untouched — it ignores non-JSON bodies, so it never sees the
// audio, and the voice router gets its own, larger ceiling.

function queryValue(req: express.Request, name: string): string | undefined {
  const raw = req.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function queryNumber(req: express.Request, name: string): number | undefined {
  const raw = queryValue(req, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

// A BCP-47 hint, or nothing. Anything else is dropped rather than forwarded to
// the provider verbatim.
function languageHint(req: express.Request): string | undefined {
  const raw = queryValue(req, "language");
  return raw && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(raw) ? raw : undefined;
}

// Never the transcript. Duration, bytes, provider, model and latency are enough
// to see quality move — the guardrail trip rate and empty-speech rate are the
// text-free signals the design relies on. OVERSEER_VOICE_DEBUG_TRANSCRIPTS=1
// adds the text, for pointing a dev instance at your own dictation.
function logDictation(context: { userId: string; workspaceId: string; peonId?: string; sessionId?: string; bytes: number; durationMs?: number; mediaType: string; totalMs: number }, result: VoicePipelineResult): void {
  const fields = [
    `user=${context.userId}`,
    `workspace=${context.workspaceId}`,
    context.peonId ? `peon=${context.peonId}` : null,
    context.sessionId ? `session=${context.sessionId}` : null,
    `bytes=${context.bytes}`,
    // The provider's own measure when it reports one, since a client can
    // understate what it declared; the claim is kept alongside it.
    result.durationSeconds === null ? null : `audioSeconds=${result.durationSeconds.toFixed(1)}`,
    context.durationMs === undefined ? null : `claimedMs=${Math.round(context.durationMs)}`,
    `mediaType=${context.mediaType}`,
    `language=${result.language ?? "auto"}`,
    `sttModel=${result.sttModel ?? "-"}`,
    `polishModel=${result.polishModel ?? "-"}`,
    `polished=${result.polished}`,
    `guardrail=${result.guardrail ?? "-"}`,
    `empty=${result.emptySpeech}`,
    `sttMs=${result.sttMs}`,
    `polishMs=${result.polishMs}`,
    `totalMs=${context.totalMs}`,
  ].filter(Boolean).join(" ");
  console.log(`voice.transcription ${fields}`);
  // The pipeline swallows a polish failure by design; without this the cause is
  // invisible and only the guardrail counter moves.
  if (result.polishError) console.warn(`voice.polish_failed guardrail=${result.guardrail} reason=${result.polishError}`);
  if (config.voice.logTranscripts) console.log(`voice.transcript raw=${JSON.stringify(result.raw)} text=${JSON.stringify(result.text)}`);
}

export function voiceRouter(): express.Router {
  const router = express.Router();

  // Lets a client hide the mic button on an instance with no provider
  // configured, mirroring the filesEnabled pattern the composer already uses.
  router.get("/capabilities", (_req, res) => {
    res.json(voiceCapabilities());
  });

  router.post(
    "/transcriptions",
    express.raw({ type: ["audio/*", "video/mp4"], limit: config.voice.maxBytes }),
    async (req, res) => {
      const startedAt = Date.now();
      if (!voiceEnabled()) {
        return res.status(503).json({ error: "voice dictation is not configured on this instance", code: "VOICE_DISABLED" });
      }

      const mediaType = normalizeMediaType(req.headers["content-type"]);
      if (!Buffer.isBuffer(req.body) || !isSupportedMediaType(mediaType)) {
        return res.status(415).json({ error: "an audio body with a supported Content-Type is required", code: "UNSUPPORTED_MEDIA_TYPE", mediaTypes: voiceCapabilities().mediaTypes });
      }
      const audio = req.body;
      if (audio.byteLength === 0) {
        return res.status(400).json({ error: "the audio body is empty", code: "EMPTY_AUDIO" });
      }
      if (audio.byteLength > config.voice.maxBytes) {
        return res.status(413).json({ error: "audio exceeds the size limit", code: "AUDIO_TOO_LARGE", maxBytes: config.voice.maxBytes });
      }

      // The duration cap is enforced twice: client-side auto-stop for the UX,
      // here for the abuse case. Duration is client-declared — we do not parse
      // the container — so the quota charges the larger of it and a byte-based
      // estimate.
      const durationMs = queryNumber(req, "durationMs");
      if (durationMs !== undefined && durationMs > config.voice.maxDurationMs) {
        return res.status(413).json({ error: "audio exceeds the duration limit", code: "AUDIO_TOO_LARGE", maxDurationMs: config.voice.maxDurationMs });
      }

      const user = userOf(req);
      const workspaceId = queryValue(req, "workspaceId") ?? "";
      const decision = await authorizeDictation({
        userId: user.userId,
        workspaceId,
        byteLength: audio.byteLength,
        durationMs,
        limits: {
          requestsPerMinute: config.voice.requestsPerMinute,
          audioSecondsPerHour: config.voice.audioSecondsPerHour,
          requestsPerDay: config.voice.requestsPerDay,
        },
      });
      if (!decision.ok) {
        if (decision.retryAfterSeconds) res.setHeader("Retry-After", String(decision.retryAfterSeconds));
        return res.status(decision.status).json({ error: decision.error, code: decision.code });
      }

      let result: VoicePipelineResult;
      try {
        result = await transcribeVoice({
          audio,
          mediaType,
          durationMs,
          language: languageHint(req),
          draft: undefined,
        });
      } catch (cause) {
        if (cause instanceof VoiceProviderError) {
          console.warn(`voice.provider_error stage=${cause.stage} status=${cause.status ?? "-"} message=${cause.message}`);
          // An upstream 429 is a rate limit, not an outage. Reporting it as 502
          // would tell the client to treat a temporary budget exhaustion as a
          // broken instance and retry immediately, which makes it worse.
          if (cause.status === 429) {
            res.setHeader("Retry-After", String(cause.retryAfterSeconds ?? 30));
            return res.status(429).json({ error: "the speech provider is rate limiting this instance", code: "VOICE_RATE_LIMITED" });
          }
          return res.status(502).json({ error: "the speech provider is unavailable", code: "VOICE_PROVIDER_ERROR" });
        }
        throw cause;
      }

      const totalMs = Date.now() - startedAt;
      // Makes the split between network and inference visible rather than
      // assumed — the measurement the latency decisions depend on.
      res.setHeader("Server-Timing", `stt;dur=${result.sttMs}, polish;dur=${result.polishMs}, total;dur=${totalMs}`);
      logDictation({
        userId: user.userId,
        workspaceId,
        peonId: queryValue(req, "peonId"),
        sessionId: queryValue(req, "sessionId"),
        bytes: audio.byteLength,
        durationMs,
        mediaType,
        totalMs,
      }, result);

      // Empty speech is a 200 with text: "", not an error — a silent clip and a
      // clip with nothing worth typing take the same client path.
      res.json({
        text: result.text,
        raw: result.raw,
        polished: result.polished,
        language: result.language,
        sttModel: result.sttModel,
        polishModel: result.polishModel,
        latencyMs: totalMs,
      });
    },
  );

  // body-parser rejects an oversized body before the handler ever runs; map its
  // error onto the same stable code the explicit check uses.
  router.use((err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    const status = typeof err === "object" && err !== null && "status" in err ? Number((err as { status: unknown }).status) : 0;
    if (status === 413) {
      return res.status(413).json({ error: "audio exceeds the size limit", code: "AUDIO_TOO_LARGE", maxBytes: config.voice.maxBytes });
    }
    next(err);
  });

  return router;
}
