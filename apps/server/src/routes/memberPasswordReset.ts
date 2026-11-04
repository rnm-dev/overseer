import type express from "express";
import { PasswordAuthError, adminResetMemberPassword } from "../modules/auth/index.js";

// Shared by the workspace members screen (owners) and the project members
// screen (project administrators). The temporary password is in this one
// response only, so it must never be cached on the way back.
export async function answerMemberPasswordReset(
  req: express.Request,
  res: express.Response,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  try {
    const result = await adminResetMemberPassword({ workspaceId, actorUserId, targetUserId, password: req.body?.password });
    res.set("Cache-Control", "no-store").json(result);
  } catch (err) {
    if (err instanceof PasswordAuthError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    console.error("auth: member password reset failed:", err instanceof Error ? err.message : err);
    res.status(500).json({ error: "password reset failed", code: "PASSWORD_RESET_ERROR" });
  }
}
