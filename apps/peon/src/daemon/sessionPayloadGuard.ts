import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "./xdgPaths.js";
import type { SessionWarning } from "./sessionWarningTypes.js";

export const SESSION_PAYLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
export const PAYLOAD_WARNING_RATIO = 0.70;
export const PAYLOAD_PROTECTION_RATIO = 0.85;
export const PAYLOAD_SAFE_TARGET_RATIO = 0.70;

export interface GuardedToolOutput {
  content: string;
  warning: Omit<SessionWarning, "type"> | null;
}

export function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = Math.min(maxBytes, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let start = Math.max(0, bytes.length - maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString("utf8");
}

function serializedToolResultBytes(toolUseId: string, content: string): number {
  return Buffer.byteLength(JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content }] },
  }), "utf8");
}

function safeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "output";
}

function persistFullOutput(sessionId: string, toolUseId: string, content: string): { path?: string; error?: string } {
  const directory = path.join(stateDir(), "sessions", sessionId, "logs");
  const filename = `${Date.now()}-${safeId(toolUseId)}-${randomUUID().slice(0, 8)}.log`;
  const target = path.join(directory, filename);
  const temporary = `${target}.tmp`;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, target);
    return { path: target };
  } catch (error) {
    try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function boundedOutput(content: string, toolUseId: string, logPath: string | undefined, targetBytes: number): string {
  const notice = `\n\n[Peon truncated this output. Full output: ${logPath ?? "unavailable because the log could not be written"}]`;
  const emptyBytes = serializedToolResultBytes(toolUseId, notice);
  const available = Math.max(0, targetBytes - emptyBytes + Buffer.byteLength(notice, "utf8"));
  let head = utf8Prefix(content, Math.floor(available * 0.6));
  let tail = utf8Suffix(content, Math.max(0, available - Buffer.byteLength(head, "utf8")));
  let bounded = `${head}${notice}${tail ? `\n\n[tail]\n${tail}` : ""}`;
  while (serializedToolResultBytes(toolUseId, bounded) > targetBytes && bounded.length > notice.length) {
    const nextBudget = Math.max(0, Math.floor(Buffer.byteLength(head + tail, "utf8") * 0.9));
    const nextHead = utf8Prefix(head, Math.floor(nextBudget * 0.6));
    const nextTail = utf8Suffix(tail, Math.max(0, nextBudget - Buffer.byteLength(nextHead, "utf8")));
    bounded = `${nextHead}${notice}${nextTail ? `\n\n[tail]\n${nextTail}` : ""}`;
    if (nextHead === head && nextTail === tail) break;
    head = nextHead;
    tail = nextTail;
  }
  return bounded;
}

export function guardToolOutput(
  sessionId: string,
  toolUseId: string,
  content: string,
  source = "command_output",
  limitBytes = SESSION_PAYLOAD_LIMIT_BYTES,
): GuardedToolOutput {
  const currentBytes = serializedToolResultBytes(toolUseId, content);
  const warningAt = Math.floor(limitBytes * PAYLOAD_WARNING_RATIO);
  const protectionAt = Math.floor(limitBytes * PAYLOAD_PROTECTION_RATIO);
  if (currentBytes < warningAt) return { content, warning: null };
  if (currentBytes < protectionAt) {
    return {
      content,
      warning: {
        sessionId,
        code: "payload_near_limit",
        source,
        currentBytes,
        limitBytes,
        message: `Command output is approaching the ${Math.round(limitBytes / 1024 / 1024)} MiB transport limit.`,
      },
    };
  }

  const stored = persistFullOutput(sessionId, toolUseId, content);
  const guarded = boundedOutput(content, toolUseId, stored.path, Math.floor(limitBytes * PAYLOAD_SAFE_TARGET_RATIO));
  return {
    content: guarded,
    warning: {
      sessionId,
      code: "payload_truncated",
      source,
      currentBytes,
      limitBytes,
      retainedBytes: serializedToolResultBytes(toolUseId, guarded),
      ...(stored.path ? { logPath: stored.path } : {}),
      ...(stored.error ? { logError: stored.error } : {}),
      message: stored.path
        ? `Command output was shortened to protect the session. The full output is available at ${stored.path}.`
        : "Command output was shortened to protect the session, but the full log could not be written.",
    },
  };
}
