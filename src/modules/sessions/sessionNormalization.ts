import type { PeonSession, SessionSummary } from "./sessionTypes.js";

// JavaScript strings may contain unpaired UTF-16 surrogates even though those
// values cannot be represented in PostgreSQL JSONB. Replace malformed units at
// the projection boundary and truncate by Unicode code point so a valid emoji
// is never split into the exact malformed value we are defending against.
export function sanitizeUnicode(value: string): string {
  let clean = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        clean += value[index] + value[index + 1];
        index += 1;
      } else {
        clean += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      clean += "\ufffd";
    } else {
      clean += value[index];
    }
  }
  return clean;
}

function sanitizeOptionalUnicode(value: string | null | undefined): string | null {
  return value == null ? null : sanitizeUnicode(value);
}

function sanitizeJsonUnicode(value: unknown): unknown {
  if (typeof value === "string") return sanitizeUnicode(value);
  if (Array.isArray(value)) return value.map(sanitizeJsonUnicode);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [sanitizeUnicode(key), sanitizeJsonUnicode(item)]));
  }
  return value;
}

function truncateUnicode(value: string, maxCodePoints: number): string {
  return [...sanitizeUnicode(value)].slice(0, maxCodePoints).join("");
}

export function normalizeSessionSummary(session: PeonSession): SessionSummary {
  return {
    id: sanitizeUnicode(session.id),
    status: sanitizeOptionalUnicode(session.status),
    projectKey: sanitizeOptionalUnicode(session.projectKey),
    projectId: sanitizeOptionalUnicode(session.projectId),
    title: sanitizeOptionalUnicode(session.title),
    promptPreview: session.promptPreview != null
      ? sanitizeUnicode(session.promptPreview)
      : session.prompt != null ? truncateUnicode(session.prompt, 200) : null,
    lastMessagePreview: sanitizeOptionalUnicode(session.lastMessagePreview),
    initiator: sanitizeOptionalUnicode(session.initiator),
    outcome: sanitizeJsonUnicode(session.outcome ?? null),
    startedAt: session.startedAt ?? null,
    endedAt: session.endedAt ?? null,
    lastActivityAt: session.lastActivityAt ?? null,
  };
}
