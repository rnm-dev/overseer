import type { Response } from "express";

export type ErrorCode =
  | "AGENT_API_DISABLED"
  | "UNAUTHENTICATED"
  | "UNSUPPORTED_PROTOCOL"
  | "BAD_REQUEST"
  | "BAD_CURSOR"
  | "UNKNOWN_SESSION"
  | "UNKNOWN_QUEUE_ITEM"
  | "SESSION_NOT_RUNNING"
  | "UPDATE_BLOCKED"
  | "RESUME_IN_PROGRESS"
  | "DIR_MISSING"
  | "FILES_DISABLED"
  | "PATH_ESCAPE"
  | "INVALID_PATH"
  | "PARENT_NOT_FOUND"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "IS_DIRECTORY"
  | "CHECKSUM_MISMATCH"
  | "DESTINATION_EXISTS"
  | "FILE_TOO_LARGE"
  | "WRITE_FAILED"
  | "RANGE_NOT_SATISFIABLE"
  | "RATE_LIMITED"
  | "UNKNOWN_PROJECT"
  | "UNKNOWN_QUICK_LINK"
  | "PROJECT_EXISTS"
  | "UNKNOWN_ATTACHMENT_PATH"
  | "ATTACHMENT_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INTERNAL";

export function fail(res: Response, status: number, code: ErrorCode, error: string): void {
  res.status(status).json({ error, code });
}
