export type SessionWarningCode = "context_near_limit" | "payload_near_limit" | "payload_truncated" | "turn_limit_exceeded" | "task_timeout";

export interface SessionWarning extends Record<string, unknown> {
  type: "session_warning";
  sessionId: string;
  code: SessionWarningCode;
  message: string;
  source?: string;
  currentBytes?: number;
  limitBytes?: number;
  retainedBytes?: number;
  currentTokens?: number;
  limitTokens?: number;
  action?: "compact" | "continue";
  canResume?: boolean;
  maxTurns?: number;
  turnBudget?: number;
  turnsUsed?: number;
  timeoutMs?: number;
  elapsedMs?: number;
  logPath?: string;
  logError?: string;
}

export interface AgentContextUsage {
  currentTokens: number;
  limitTokens: number;
}
