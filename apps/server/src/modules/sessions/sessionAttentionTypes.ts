/** Operator-scoped attention state emitted after a session lifecycle change. */
export interface SessionAttentionPayload {
  userId: string;
  peonId: string;
  sessionId: string;
  unread: boolean;
  hasOutstandingRequest: boolean;
  lastRequestedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}
