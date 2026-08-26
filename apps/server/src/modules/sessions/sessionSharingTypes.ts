import type { AuthContext } from "../auth/index.js";

export type SessionInvitationAccess = "read" | "participate";
export type SessionParticipantProvenance = "direct" | "invitation";
export type SessionParticipantStatus = "active" | "expired" | "revoked";
export type SessionUsageQuality = "unknown" | "observed" | "estimated";

export interface SessionSharingLimits {
  maxTurns: number;
  maxDurationMs: number;
  maxTokens: number;
}

export interface SessionInvitationInput extends Partial<SessionSharingLimits> {
  displayName: unknown;
  accessMode?: unknown;
  expiresInMs?: unknown;
}

export interface SessionInvitationView {
  id: string;
  workspaceId: string;
  peonId: string;
  sessionId: string;
  displayName: string;
  accessMode: SessionInvitationAccess;
  limits: SessionSharingLimits;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  status: SessionParticipantStatus;
  participantCount: number;
  activeParticipantCount: number;
}

export interface SessionInvitationPreview extends SessionInvitationView {
  sessionTitle: string | null;
  sessionStatus: string | null;
  alreadyAuthorized: boolean;
}

export interface SessionParticipantAuth {
  participantId: string;
  invitationId: string | null;
  workspaceId: string;
  peonId: string;
  sessionId: string;
  accessMode: SessionInvitationAccess;
  provenance: SessionParticipantProvenance;
  userId: string | null;
  guestId: string | null;
  email: string | null;
  githubLogin: string | null;
  avatarUrl: string | null;
  displayName: string;
  actor: string;
  isGuest: boolean;
  expiresAt: number | null;
}

export interface SessionParticipantUsage {
  turns: number;
  tokens: number;
  costMicros: number;
  quality: SessionUsageQuality;
}

export interface SessionParticipantView {
  participantId: string;
  invitationId: string | null;
  identity: {
    kind: "authenticated" | "guest";
    userId: string | null;
    guestId: string | null;
    email: string | null;
    githubLogin: string | null;
    displayName: string;
  };
  displayName: string;
  accessMode: SessionInvitationAccess;
  provenance: SessionParticipantProvenance;
  joinedAt: number;
  lastActiveAt: number;
  expiresAt: number | null;
  revokedAt: number | null;
  status: SessionParticipantStatus;
  usage: SessionParticipantUsage;
  presence: {
    status: "online" | "away" | "offline";
    lastSeenAt: number | null;
  };
}

export interface SessionAcceptance {
  alreadyAuthorized: boolean;
  workspaceId: string;
  peonId: string;
  sessionId: string;
  sessionTitle: string | null;
  accessMode: SessionInvitationAccess | null;
  participant: SessionParticipantView | null;
  participantCredential: { token: string; expiresAt: number } | null;
  webSocketTicket: { ticket: string; expiresAt: number } | null;
}

export class SessionSharingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "SessionSharingError";
  }
}

export function authContextForParticipant(participant: SessionParticipantAuth): AuthContext | null {
  if (!participant.userId || !participant.email) return null;
  return {
    userId: participant.userId,
    email: participant.email,
    githubLogin: participant.githubLogin,
    avatarUrl: participant.avatarUrl,
    // Scoped participants do not use this value for authorization. Keeping a
    // stable marker makes accidental use in an unrelated device operation
    // obvious during review.
    deviceId: `session-participant:${participant.participantId}`,
  };
}
