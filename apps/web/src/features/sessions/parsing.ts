import type { Translate } from "../../shared/i18n";
import type { SelectedTextReply } from "./selectedTextReply";
import type { ComposerMention, MentionPrincipal } from "./contextMentions";

// Shared alias for the translate function threaded through the render atoms.
export type T = Translate;

// Claude Code stream-json transcript events (also what the live tail emits).
export interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
  id?: string;
  tool_use_id?: string;
}
export interface Ev {
  type?: string;
  text?: string;
  author?: string | MentionPrincipal;
  authorPrincipal?: MentionPrincipal;
  mentions?: ComposerMention[];
  authorEmail?: string;
  authorGithubLogin?: string;
  authorAvatarUrl?: string;
  commandId?: string;
  message?: { role?: string; content?: Block[] | string; usage?: unknown };
  model?: string;
  cwd?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
  content?: unknown;
  path?: string;
  createdAt?: number;
  attachments?: MessageAttachment[];
  replyTo?: SelectedTextReply;
  // Durable pagination identity on capable Peons. Legacy transcripts omit it.
  eventId?: string;
  // Client-only reconciliation metadata: where the live tail delivered this row.
  // Never sent back to Peon, and flattenEvents intentionally ignores it.
  _tailEventId?: string;
  _tailId?: number;
  [k: string]: unknown;
}

export interface MessageAttachment {
  type?: "file" | "image";
  path?: string;
  name?: string;
  size?: number;
}

const ORCISH_THINKING_LABELS = [
  "Work work!",
  "WAAAGH in progress!",
  "Berserker focus mode!",
  "Hacking the battle plans!",
  "Stomping through logic!",
  "Forging the next swing!",
  "Teeth on the byte-grind!",
  "Crushing bugs like chitin!",
  "Axes sharpened, output incoming!",
  "Grunts are thinking, quietly!",
  "Orcish focus…",
];

export function orcishThinkingLabel(seed: string = ""): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(31, hash) + seed.charCodeAt(i);
    hash = hash >>> 0;
  }
  return ORCISH_THINKING_LABELS[hash % ORCISH_THINKING_LABELS.length]!;
}

export const compactNum = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : typeof c === "string" ? c : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

// Tool adapters return both plain text and serialized JSON through the same
// string field. Keep ordinary output byte-for-byte as it arrived, but give
// compound JSON values a stable, readable representation in the details view.
export function prettyJsonOutput(source: string): string | null {
  const trimmed = source.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    if (value === null || typeof value !== "object") return null;
    return JSON.stringify(value, null, 2);
  } catch {
    return null;
  }
}

// Edit is a state-changing system command. Its useful result is the diff shown
// in the changes section; the runtime does not emit a meaningful stdout block.
export function toolHasOutputSection(name?: string): boolean {
  return name?.trim().toLowerCase() !== "edit";
}

export function toolSummary(input: unknown, name?: string): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.filePath ?? i.path ?? i.filename ?? i.pattern ?? i.url ?? i.description ?? i.prompt ?? i.query;
  if (typeof v === "string" && v.trim()) return v;

  // Patch-based clients do not always send Edit's traditional `file_path`.
  // Pull the target out of the patch header so the collapsed row is not blank.
  if (name === "Edit") {
    if (Array.isArray(i.changes)) {
      const paths = i.changes
        .map((change) => change && typeof change === "object" ? (change as Record<string, unknown>).path : undefined)
        .filter((path): path is string => typeof path === "string" && !!path.trim());
      if (paths.length === 1) return paths[0]!;
      if (paths.length > 1) return `${paths[0]} (+${paths.length - 1})`;
    }
    const patch = i.patch ?? i.diff;
    if (typeof patch === "string") {
      const target = patch.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m)?.[1]
        ?? patch.match(/^\+\+\+\s+(?:b\/)?(.+)$/m)?.[1];
      if (target?.trim()) return target.trim();
      if (patch.trim()) return patch.trim().split("\n", 1)[0] ?? "";
    }
    if (typeof i.old_string === "string" || typeof i.new_string === "string") return "text replacement";
  }
  return "";
}
// Output tokens are the useful headline — cache_read is context reread every
// turn and dwarfs everything else, so a raw token sum reads as wildly inflated.
// Never headline it; keep it as a breakdown detail instead.
export interface UsageBreakdown {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  costUsd?: number;
}
export function usageBreakdown(usage: unknown): UsageBreakdown | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const input = num(u.input_tokens ?? u.inputTokens);
  const output = num(u.output_tokens ?? u.outputTokens);
  const cacheCreate = num(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens);
  const cacheRead = num(u.cache_read_input_tokens ?? u.cacheReadInputTokens);
  if (!input && !output && !cacheCreate && !cacheRead) return null;
  const rawCost = u.total_cost_usd ?? u.totalCostUsd;
  return { input, output, cacheCreate, cacheRead, costUsd: typeof rawCost === "number" ? rawCost : undefined };
}

export function usageFromEvent(ev: Ev): UsageBreakdown | null {
  return usageBreakdown(ev.message?.usage) ?? usageBreakdown((ev as { usage?: unknown }).usage);
}
// Structural signature for de-duping the snapshot/tail overlap (events carry no
// stable id). The peon serializes the same event identically on both channels, so
// stringify equality is a reliable match.
export const sig = (ev: Ev): string => JSON.stringify(ev);

// Transcript events are also the most immediate run-lifecycle signal. Only
// events accepted as fresh by the caller may drive this: a reconnect can replay
// an older turn, and letting a replayed `result` win would hide the indicator in
// the middle of the current turn.
export type RunSignal = "running" | "idle" | null;
export function runSignalFromEvent(ev: Ev): RunSignal {
  if (ev.type === "result") return "idle";
  switch (ev.type) {
    case "user_message":
    case "system":
    case "assistant":
    case "user":
    case "rate_limit_event":
      return "running";
    default:
      return null;
  }
}

export function latestRunSignal(events: Ev[]): RunSignal {
  for (let i = events.length - 1; i >= 0; i--) {
    const signal = runSignalFromEvent(events[i]);
    if (signal) return signal;
  }
  return null;
}

// The transcript is a flat list of events, but a tool call and its result arrive
// as two separate events (tool_use in an "assistant" event, tool_result in a
// later "user" event) — flatten everything into a single ordered item list so a
// tool call renders as one row once its result lands, matched by tool_use_id.
export type Item =
  | { kind: "user"; key: string; text: string; mentions?: ComposerMention[]; sourceEventId?: string; replyTo?: SelectedTextReply; author?: string; authorEmail?: string; authorGithubLogin?: string; authorAvatarUrl?: string; attachments?: MessageAttachment[]; createdAt?: number }
  | { kind: "participant"; key: string; text: string; sourceEventId?: string; author: MentionPrincipal; mentions?: ComposerMention[]; attachments?: MessageAttachment[]; createdAt?: number }
  | { kind: "text"; key: string; text: string; sourceEventId?: string; createdAt?: number; resultMeta?: { tone?: "neutral" | "error"; text: string } }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "tool"; key: string; name?: string; input?: unknown; result?: { text: string; error?: boolean } }
  | { kind: "loose"; key: string; text: string }
  | { kind: "notice"; key: string; tone?: "neutral" | "error"; text: string }
  | { kind: "preview"; key: string; path: string; author?: string; createdAt?: number }
  | { kind: "raw"; key: string; text: string };

function renderEventKey(event: Ev, index: number): string {
  const durableId = event.eventId ?? event._tailEventId ?? event._tailId;
  return durableId === undefined || durableId === null ? `index:${index}` : `event:${durableId}`;
}

export function flattenEvents(events: Ev[], t: T): Item[] {
  const items: Item[] = [];
  const toolIndex = new Map<string, number>(); // tool_use id -> index in items, for pairing its later result

  events.forEach((ev, ei) => {
    const eventKey = renderEventKey(ev, ei);
    switch (ev.type) {
      case "user_message":
        items.push({ kind: "user", key: eventKey, sourceEventId: ev.eventId, replyTo: ev.replyTo, text: ev.text || "", mentions: ev.mentions, author: typeof ev.author === "string" ? ev.author : ev.author?.label, authorEmail: ev.authorEmail, authorGithubLogin: ev.authorGithubLogin, authorAvatarUrl: ev.authorAvatarUrl, attachments: ev.attachments, createdAt: ev.createdAt });
        return;
      case "participant_message":
        if (ev.author && typeof ev.author === "object") {
          items.push({ kind: "participant", key: eventKey, sourceEventId: ev.eventId, text: ev.text || "", author: ev.author, mentions: ev.mentions, attachments: ev.attachments, createdAt: ev.createdAt });
        }
        return;
      case "assistant": {
        const blocks = Array.isArray(ev.message?.content) ? (ev.message!.content as Block[]) : [];
        blocks.forEach((b, bi) => {
          const key = `${eventKey}:${bi}`;
          if (b.type === "text" && b.text?.trim()) items.push({ kind: "text", key, sourceEventId: ev.eventId, text: b.text, createdAt: ev.createdAt });
          else if (b.type === "thinking" && b.thinking?.trim()) items.push({ kind: "thinking", key, text: b.thinking });
          else if (b.type === "tool_use") {
            items.push({ kind: "tool", key, name: b.name, input: b.input });
            if (b.id) toolIndex.set(b.id, items.length - 1);
          }
        });
        return;
      }
      case "user": {
        // Tool results are fed back as a user-role message per the Anthropic API.
        const blocks = Array.isArray(ev.message?.content) ? (ev.message!.content as Block[]) : [];
        blocks.forEach((b, bi) => {
          const key = `${eventKey}:${bi}`;
          if (b.type === "tool_result") {
            const result = { text: textFromContent(b.content), error: !!b.is_error };
            const idx = b.tool_use_id ? toolIndex.get(b.tool_use_id) : undefined;
            if (idx !== undefined) items[idx] = { ...(items[idx] as Extract<Item, { kind: "tool" }>), result };
            else items.push({ kind: "tool", key, result }); // no matching tool_use (older transcript) — show standalone
          } else if (b.type === "text" && b.text) {
            items.push({ kind: "loose", key, text: b.text });
          }
        });
        return;
      }
      case "system":
        // Auto-resume re-inits the agent, so these repeat constantly — too noisy.
        return;
      case "result": {
        const parts: string[] = [];
        if (typeof ev.duration_ms === "number") parts.push(`${Math.round(ev.duration_ms / 1000)}s`);
        if (typeof ev.num_turns === "number") parts.push(t("session.chat.turns", { n: ev.num_turns }));
        const out = ev.usage?.output_tokens ?? 0;
        if (out > 0) parts.push(`${compactNum.format(out)} ${t("peon.stats.outputTokens").toLowerCase()}`);
        if (parts.length) {
          const resultMeta = { tone: ev.is_error ? "error" as const : "neutral" as const, text: parts.join(" · ") };
          let lastText: Extract<Item, { kind: "text" }> | undefined;
          for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === "user") break;
            if (items[i].kind === "text") {
              lastText = items[i] as Extract<Item, { kind: "text" }>;
              break;
            }
          }
          if (lastText) lastText.resultMeta = resultMeta;
          else items.push({ kind: "notice", key: eventKey, ...resultMeta });
        }
        return;
      }
      case "rate_limit_event":
        return;
      case "preview":
        if (typeof ev.path === "string" && ev.path) items.push({ kind: "preview", key: eventKey, path: ev.path, author: typeof ev.author === "string" ? ev.author : undefined, createdAt: ev.createdAt });
        return;
      case "_raw":
        items.push({ kind: "raw", key: eventKey, text: ev.text || "" });
        return;
      default: {
        const text = ev.text ?? textFromContent(ev.content);
        if (text) items.push({ kind: "raw", key: eventKey, text });
      }
    }
  });
  return items;
}

// Spacing between two adjacent transcript rows. Consecutive user messages sit
// close together (they read as one burst); a user message next to anything else
// gets extra breathing room on that side so it reads as its own turn.
export function gapClass(prevIsUser: boolean, isUser: boolean, textBoundary = false): string {
  if (prevIsUser && isUser) return "mt-1";
  if (prevIsUser !== isUser) return "mt-6";
  if (textBoundary) return "mt-4";
  return "mt-0.5";
}

// Virtuoso measures each row independently, so its spacing belongs inside the
// row rather than in a collapsing outer margin. Keep these as literal Tailwind
// classes: constructing `pt-*` at runtime means Tailwind never emits them.
export function gapPaddingClass(prevIsUser: boolean, isUser: boolean, textBoundary = false): string {
  if (prevIsUser && isUser) return "pt-1";
  if (prevIsUser !== isUser) return "pt-6";
  if (textBoundary) return "pt-4";
  return "pt-0.5";
}

// Contextual "agent is working" label from the freshest transcript event — so the
// operator sees *what* it's doing (running a command, reading a file…), not just a spinner.
function toolActivity(name?: string): { key: string; name?: string } {
  switch (name) {
    case "Bash":
      return { key: "session.working.bash" };
    case "Read":
      return { key: "session.working.read" };
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return { key: "session.working.edit" };
    case "Grep":
    case "Glob":
      return { key: "session.working.search" };
    case "WebFetch":
    case "WebSearch":
      return { key: "session.working.web" };
    case "Task":
    case "Agent":
      return { key: "session.working.subagent" };
    default:
      return { key: "session.working.tool", name: name || "tool" };
  }
}
export function workingActivity(last: Ev | undefined): { key: string; name?: string } {
  if (last?.type === "assistant") {
    const blocks = Array.isArray(last.message?.content) ? (last.message!.content as Block[]) : [];
    const b = [...blocks].reverse().find((x) => x.type === "tool_use" || (x.type === "text" && !!x.text?.trim()));
    if (b?.type === "tool_use") return toolActivity(b.name);
    if (b?.type === "text") return { key: "session.working.typing" };
  }
  return { key: "session.working.thinking" };
}
