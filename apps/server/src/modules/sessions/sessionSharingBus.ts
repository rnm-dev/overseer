import { EventEmitter } from "node:events";

export interface SessionParticipantRevokedEvent {
  participantId: string;
  workspaceId: string;
  peonId: string;
  sessionId: string;
}

class SessionSharingBus extends EventEmitter {
  emitParticipantRevoked(payload: SessionParticipantRevokedEvent): boolean {
    return this.emit("participant-revoked", payload);
  }

  onParticipantRevoked(listener: (payload: SessionParticipantRevokedEvent) => void): this {
    return this.on("participant-revoked", listener);
  }

  offParticipantRevoked(listener: (payload: SessionParticipantRevokedEvent) => void): this {
    return this.off("participant-revoked", listener);
  }
}

export const sessionSharingBus = new SessionSharingBus();
