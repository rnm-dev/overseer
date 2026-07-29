import { membership } from "../workspaces/index.js";
import { checkVoiceQuota, estimateAudioSeconds, type VoiceQuotaLimits } from "./voiceQuota.js";

// Who may dictate, and how much. The route translates transport; the decision
// of whether a given upload is allowed at all lives here.
//
// Gating on workspace membership rather than mere authentication is the point:
// anyone with a GitHub account can sign in, and only a member of a workspace
// may spend that workspace's instance key on transcription.

export type DictationDecision =
  | { ok: true; chargedSeconds: number }
  | { ok: false; status: number; code: string; error: string; retryAfterSeconds?: number };

export interface DictationRequest {
  userId: string;
  workspaceId: string;
  byteLength: number;
  durationMs?: number;
  limits: VoiceQuotaLimits;
}

export async function authorizeDictation(request: DictationRequest): Promise<DictationDecision> {
  if (!request.workspaceId) {
    return { ok: false, status: 400, code: "MISSING_WORKSPACE", error: "workspaceId is required" };
  }
  // Same 404-not-403 shape the rest of the operator API uses: a non-member
  // learns nothing about whether the workspace exists.
  if (!(await membership(request.workspaceId, request.userId))) {
    return { ok: false, status: 404, code: "UNKNOWN_WORKSPACE", error: "unknown workspace" };
  }

  const chargedSeconds = estimateAudioSeconds(request.byteLength, request.durationMs);
  const quota = checkVoiceQuota(request.userId, chargedSeconds, request.limits);
  if (!quota.allowed) {
    return {
      ok: false,
      status: 429,
      code: "VOICE_RATE_LIMITED",
      error: quota.reason === "requests" ? "too many dictation requests"
        : quota.reason === "instance-day" ? "this instance's daily dictation budget is exhausted"
        : "dictation audio budget exhausted",
      retryAfterSeconds: quota.retryAfterSeconds,
    };
  }
  return { ok: true, chargedSeconds };
}
