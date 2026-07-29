export const RESTART_INTERRUPTION_MARKER = "restarted while this session was running";
export const ORPHANED_RUN_MARKER = "run disappeared while the daemon remained online";

// Lifetime cap on automatic restart-recovery resumes for a single ad-hoc
// session. Persisted per-record (autoResumeAttempts) so it survives across
// restarts — an orphan that keeps getting killed by successive restarts before
// it can finish won't be resumed forever.
export const MAX_AUTO_RESUME_ATTEMPTS = 3;

// The follow-up handed to an ad-hoc session being auto-resumed after a restart
// interrupted it. --resume replays the CLI's own persisted conversation, so the
// agent still has its prior context; this just tells it why it's being poked
// again and to carry on.
export const AUTO_RESUME_PROMPT =
  "This session was interrupted when the daemon restarted before it finished. " +
  "Your previous context is intact — continue where you left off and complete the original request.";

// The author stamped on a user_message that the daemon itself injected rather
// than a human typing it — the task-processor's automation prompts and the
// post-restart auto-resume nudge. Distinguishes machine-authored turns from a
// genuine human follow-up in a shared session's transcript.
export const SYSTEM_AUTHOR = "system";
