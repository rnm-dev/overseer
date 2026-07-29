import { query } from "./db.js";

interface TranscriptEvent {
  type?: string;
  text?: string;
  author?: string;
  authorEmail?: string;
  authorGithubLogin?: string;
  authorAvatarUrl?: string;
  commandId?: string;
  createdAt?: number;
  [key: string]: unknown;
}

interface MessageCandidate {
  text: string;
  createdAt: number;
  commandId?: string;
}

interface AuthorIdentity {
  email: string;
  githubLogin: string | null;
  avatarUrl?: string | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function promptFromResponse(value: unknown): string | null {
  const response = object(value);
  const prompts = response?.followUpPrompts;
  if (!Array.isArray(prompts)) return null;
  const prompt = prompts[prompts.length - 1];
  return typeof prompt === "string" ? prompt : null;
}

export function addUserMessageMetadata(
  events: TranscriptEvent[],
  candidates: MessageCandidate[],
  identities: AuthorIdentity[] = [],
): TranscriptEvent[] {
  let cursor = 0;
  return events.map((event) => {
    if (event.type !== "user_message" || typeof event.text !== "string") return event;
    const index = candidates.findIndex((candidate, i) => i >= cursor && candidate.text === event.text);
    const candidate = index >= 0 ? candidates[index]! : null;
    if (candidate) cursor = index + 1;

    const identity = typeof event.author === "string"
      ? identities.find((item) => item.email === event.author || item.githubLogin === event.author)
      : undefined;

    return {
      ...event,
      ...(candidate && typeof event.createdAt !== "number" ? { createdAt: candidate.createdAt } : {}),
      ...(candidate?.commandId && typeof event.commandId !== "string" ? { commandId: candidate.commandId } : {}),
      ...(identity ? {
        author: identity.email,
        authorEmail: identity.email,
        ...(identity.githubLogin ? { authorGithubLogin: identity.githubLogin } : {}),
        ...(identity.avatarUrl ? { authorAvatarUrl: identity.avatarUrl } : {}),
      } : {}),
    };
  });
}

export async function enrichTranscriptMetadata(peonId: string, sessionId: string, events: TranscriptEvent[]): Promise<TranscriptEvent[]> {
  const [sessionResult, followupResult, identityResult] = await Promise.all([
    query<{ started_at: number | null }>(
      `SELECT started_at FROM sessions WHERE peon_id=$1 AND session_id=$2`,
      [peonId, sessionId],
    ),
    query<{ command_id: string; request_body: unknown; response_body: unknown; created_at: number }>(
      `SELECT command_id, request_body, response_body, created_at FROM followup_commands
       WHERE peon_id=$1 AND session_id=$2 AND response_status >= 200 AND response_status < 300
       ORDER BY created_at`,
      [peonId, sessionId],
    ),
    query<{ email: string; github_login: string | null; avatar_url: string | null }>(
      `SELECT email, github_login, avatar_url FROM users`,
    ),
  ]);

  const candidates: MessageCandidate[] = [];
  const session = sessionResult.rows[0];
  const firstUserMessage = events.find((event) => event.type === "user_message" && typeof event.text === "string");
  if (firstUserMessage && typeof firstUserMessage.text === "string" && typeof session?.started_at === "number") {
    candidates.push({ text: firstUserMessage.text, createdAt: session.started_at });
  }

  for (const row of followupResult.rows) {
    const request = object(row.request_body);
    const response = object(row.response_body);
    const text = typeof request?.prompt === "string" ? request.prompt : promptFromResponse(response);
    const responseTime = response?.lastUserMessageAt;
    if (text !== null) candidates.push({
      text,
      createdAt: typeof responseTime === "number" ? responseTime : row.created_at,
      commandId: row.command_id,
    });
  }
  return addUserMessageMetadata(
    events,
    candidates,
    identityResult.rows.map((row) => ({ email: row.email, githubLogin: row.github_login, avatarUrl: row.avatar_url })),
  );
}
