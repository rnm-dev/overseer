import { query } from "../../infrastructure/db/index.js";

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

    return withAuthorIdentity({
      ...event,
      ...(candidate && typeof event.createdAt !== "number" ? { createdAt: candidate.createdAt } : {}),
      ...(candidate?.commandId && typeof event.commandId !== "string" ? { commandId: candidate.commandId } : {}),
    }, identities);
  });
}

function matchIdentity(author: unknown, identities: AuthorIdentity[]): AuthorIdentity | undefined {
  if (typeof author !== "string") return undefined;
  // The browser compares its own identity case-insensitively; an actor string
  // whose case differs from the stored row must not silently lose its profile.
  const key = author.trim().toLowerCase();
  if (!key) return undefined;
  return identities.find((item) => item.email.toLowerCase() === key || item.githubLogin?.toLowerCase() === key);
}

// One rendering of authorship for every surface. The wire carries a single
// author string (Peon-Actor, deliberately the canonical email); the display
// name and avatar are local profile metadata resolved at read time, never
// stored beside the event.
export function withAuthorIdentity<T extends TranscriptEvent>(event: T, identities: AuthorIdentity[]): T {
  const identity = matchIdentity(event.author, identities);
  if (!identity) return event;
  return {
    ...event,
    author: identity.email,
    authorEmail: identity.email,
    ...(identity.githubLogin ? { authorGithubLogin: identity.githubLogin } : {}),
    ...(identity.avatarUrl ? { authorAvatarUrl: identity.avatarUrl } : {}),
  };
}

const IDENTITY_TTL_MS = 60_000;
let identityCache: { at: number; identities: AuthorIdentity[] } | null = null;
let identityLoad: Promise<AuthorIdentity[]> | null = null;

async function loadAuthorIdentities(): Promise<AuthorIdentity[]> {
  const rows = await query<{ email: string; github_login: string | null; avatar_url: string | null }>(
    `SELECT email, github_login, avatar_url FROM users`,
  );
  return rows.rows.map((row) => ({ email: row.email, githubLogin: row.github_login, avatarUrl: row.avatar_url }));
}

// Live transcript frames arrive one at a time and would otherwise cost a users
// scan each. A minute of staleness only delays a freshly linked GitHub profile.
export async function authorIdentities(): Promise<AuthorIdentity[]> {
  if (identityCache && Date.now() - identityCache.at < IDENTITY_TTL_MS) return identityCache.identities;
  identityLoad ??= loadAuthorIdentities()
    .then((identities) => {
      identityCache = { at: Date.now(), identities };
      return identities;
    })
    .finally(() => {
      identityLoad = null;
    });
  return identityLoad;
}

export function resetAuthorIdentityCache(): void {
  identityCache = null;
  identityLoad = null;
}

// Best-effort: a transcript frame is never withheld because local profile
// metadata could not be read.
export async function enrichLiveTranscriptEvent<T extends TranscriptEvent>(event: T): Promise<T> {
  if (typeof event.author !== "string") return event;
  try {
    return withAuthorIdentity(event, await authorIdentities());
  } catch {
    return event;
  }
}

export async function enrichTranscriptMetadata(peonId: string, sessionId: string, events: TranscriptEvent[]): Promise<TranscriptEvent[]> {
  const [sessionResult, followupResult, identities] = await Promise.all([
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
    authorIdentities(),
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
  return addUserMessageMetadata(events, candidates, identities);
}
