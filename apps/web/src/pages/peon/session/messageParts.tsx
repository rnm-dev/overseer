import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "../../../ui";
import { HighlightedCode, Markdown } from "../../../components/RichText";
import { orcishThinkingLabel, prettyJsonOutput, toolHasOutputSection, toolSummary, type Item, type MessageAttachment, type T } from "./parsing";
import { Avatar } from "../../../components/Avatar";
import { FilePlus, FileX, ImageIcon, Paperclip, Pencil, Terminal } from "lucide-react";
import { projectViewerHref, projectViewerRelativePath, type ProjectViewerContext } from "./projectViewerLink";
import { useAuth, type User } from "../../../auth";
import { useI18n, type Locale } from "../../../i18n";
import { formatLocalTimestamp, localeTag } from "../../../timeFormat";

// The transcript render atoms: one component per Item kind, plus the Markdown
// renderer and the "agent is working" indicator. Pure presentation — all parsing
// lives in ./parsing. author: Viktor

export const OWN_ATTACHMENT_CLASS = "bg-iron-950/25 text-bone hover:bg-iron-950/40";
export const OTHER_ATTACHMENT_CLASS = "on-surface text-bone hover:bg-iron-700/60";

export function attachmentMeta(attachment: MessageAttachment): string {
  const label = attachment.name || attachment.path?.split(/[\\/]/).pop() || "attachment";
  const extension = label.includes(".") ? label.split(".").pop()?.toUpperCase() : undefined;
  const kind = attachment.type === "image" ? (extension || "IMAGE") : (extension || "FILE");
  if (!attachment.size || attachment.size < 1) return kind;
  const units = ["B", "KB", "MB", "GB"];
  let size = attachment.size;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  const formatted = unit === 0 || size >= 10 ? Math.round(size).toString() : size.toFixed(1);
  return `${kind} · ${formatted} ${units[unit]}`;
}

function AttachmentPill({ attachment, mine, onOpen }: { attachment: MessageAttachment; mine: boolean; onOpen?: () => void }) {
  const label = attachment.name || attachment.path?.split(/[\\/]/).pop() || "attachment";
  const className = `group/attachment flex min-w-0 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors ${mine ? OWN_ATTACHMENT_CLASS : OTHER_ATTACHMENT_CLASS}`;
  const iconClass = `grid h-7 w-7 shrink-0 place-items-center rounded-md ${mine ? "bg-bone/10 text-bone/80" : "bg-forge/10 text-forge"}`;
  const contents = <>
      <span className={iconClass} aria-hidden>
        {attachment.type === "image" ? <ImageIcon size={14} /> : <Paperclip size={14} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-xs font-semibold">{label}</span>
        <span className={`mt-0.5 block font-mono text-[0.65rem] leading-none ${mine ? "text-bone/55" : "text-bone-faint"}`}>{attachmentMeta(attachment)}</span>
      </span>
    </>;
  return onOpen ? <button type="button" className={`${className} cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${mine ? "focus-visible:ring-bone/50" : "focus-visible:ring-fel/60"}`} title={attachment.path || label} onClick={onOpen}>{contents}</button>
    : <div className={className} title={attachment.path || label}>{contents}</div>;
}

function LocalMessageTime({ createdAt, locale, yesterdayLabel }: { createdAt?: number; locale: Locale; yesterdayLabel: string }) {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  const visible = formatLocalTimestamp(createdAt, Date.now(), locale, yesterdayLabel);
  const local = date.toLocaleString(localeTag(locale));
  return <time dateTime={date.toISOString()} title={`${local} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`}>{visible}</time>;
}

const USER_BUBBLE_BASE_CLASS = "max-w-[80%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm px-3 py-1.5 typo-chat-message text-bone";
export const OWN_USER_BUBBLE_CLASS = `${USER_BUBBLE_BASE_CLASS} bg-forge-deep`;
export const OTHER_USER_BUBBLE_CLASS = `${USER_BUBBLE_BASE_CLASS} surface`;
export const OTHER_USER_BUBBLE_AUTHOR_CLASS = "mb-1 truncate font-body text-[0.68rem] font-semibold leading-tight text-fel-bright";
export const OWN_USER_BUBBLE_TIME_CLASS = "font-body text-[0.65rem] leading-tight text-bone/60";
export const OTHER_USER_BUBBLE_TIME_CLASS = "font-body text-[0.65rem] leading-tight text-bone-faint";

export function isCompactUserMessage(text: string, attachments?: MessageAttachment[]): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 48 && !trimmed.includes("\n") && !attachments?.length;
}

export function isOwnMessageAuthor(user: User | null, authorEmail?: string, authorGithubLogin?: string, author?: string): boolean {
  if (!user) return false;
  const currentIdentities = [user.email, user.githubLogin].filter((value): value is string => !!value).map((value) => value.toLowerCase());
  const authorIdentities = [authorEmail, authorGithubLogin, author].filter((value): value is string => !!value).map((value) => value.toLowerCase());
  return authorIdentities.some((identity) => currentIdentities.includes(identity));
}

export function userMessageAvatar(
  user: User | null,
  authorAvatarUrl?: string,
  authorEmail?: string,
  authorGithubLogin?: string,
  author?: string,
): string | undefined {
  if (authorAvatarUrl) return authorAvatarUrl;
  if (!isOwnMessageAuthor(user, authorEmail, authorGithubLogin, author)) return undefined;
  return user?.avatarUrl || undefined;
}

export function UserBubble({ text, author, authorEmail, authorGithubLogin, authorAvatarUrl, attachments, createdAt, onOpenAttachment }: { text: string; author?: string; authorEmail?: string; authorGithubLogin?: string; authorAvatarUrl?: string; attachments?: MessageAttachment[]; createdAt?: number; onOpenAttachment?: (attachment: MessageAttachment) => void }) {
  const { user } = useAuth();
  const { locale, t } = useI18n();
  const mine = isOwnMessageAuthor(user, authorEmail, authorGithubLogin, author);
  const compact = isCompactUserMessage(text, attachments);
  const displayAuthor = authorGithubLogin || authorEmail || author;
  const avatarLabel = displayAuthor || "Unknown message author";
  const avatarUrl = userMessageAvatar(user, authorAvatarUrl, authorEmail, authorGithubLogin, author);
  return (
    <div className="flex items-end justify-end gap-2">
      <div className={mine ? OWN_USER_BUBBLE_CLASS : OTHER_USER_BUBBLE_CLASS}>
        {!mine && displayAuthor && <div className={OTHER_USER_BUBBLE_AUTHOR_CLASS} title={displayAuthor}>{displayAuthor}</div>}
        {compact ? (
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1">{text}</div>
            {createdAt && <div className={`${mine ? OWN_USER_BUBBLE_TIME_CLASS : OTHER_USER_BUBBLE_TIME_CLASS} shrink-0 pb-px`}><LocalMessageTime createdAt={createdAt} locale={locale} yesterdayLabel={t("peon.stats.period.yesterday")} /></div>}
          </div>
        ) : text ? <div>{text}</div> : null}
        {!!attachments?.length && (
          <div className={text ? "mt-2 grid gap-1" : "grid gap-1"}>
            {attachments.map((attachment, i) => <AttachmentPill key={`${attachment.path || attachment.name || "attachment"}-${i}`} attachment={attachment} mine={mine} onOpen={attachment.path ? () => onOpenAttachment?.(attachment) : undefined} />)}
          </div>
        )}
        {createdAt && !compact && <div className={`${mine ? OWN_USER_BUBBLE_TIME_CLASS : OTHER_USER_BUBBLE_TIME_CLASS} mt-1 text-right`}><LocalMessageTime createdAt={createdAt} locale={locale} yesterdayLabel={t("peon.stats.period.yesterday")} /></div>}
      </div>
      <Avatar src={avatarUrl} label={avatarLabel} className="border-fel/35 bg-fel/15 text-fel-bright" />
    </div>
  );
}

// Session-summary strip — sits right under the assistant's last message, so it
// pulls up against the preceding item's bottom (negating the list's space-y gap)
// instead of floating in its own row.
function Notice({ tone, children }: { tone?: "neutral" | "error"; children: ReactNode }) {
  return (
    <div className={`-mt-2.5 flex justify-start font-body text-[0.7rem] ${tone === "error" ? "text-blood" : "text-bone-faint"}`}>{children}</div>
  );
}

// A tool call collapsed to a single clipped line — icon, name, clipped command —
// with a Details button that opens the full command + output in a modal. Command
// output is never shown inline; it's noise unless the operator asks for it.
function ToolRow({ name, input, result, t }: { name?: string; input?: unknown; result?: { text: string; error?: boolean }; t: T }) {
  const [open, setOpen] = useState(false);
  const command = toolSummary(input, name);
  const failed = !!result?.error;
  const isEdit = !toolHasOutputSection(name);
  const operation = isEdit ? editOperation(input) : null;
  const stats = isEdit ? editStatsFromInput(input) : null;
  return (
    <div className="flex justify-start">
      <div className={`flex min-w-0 max-w-[85%] items-center gap-1.5 py-0.5 typo-code-snippet ${failed ? "text-blood" : ""}`}>
        <span className={`flex shrink-0 items-center gap-1 ${failed ? "text-blood" : "text-fel-bright"}`}>
          {operation === "Create" ? <FilePlus size={13} aria-hidden /> : operation === "Delete" ? <FileX size={13} aria-hidden /> : isEdit ? <Pencil size={13} aria-hidden /> : <Terminal size={13} aria-hidden />}
          {operation ?? name ?? t("session.chat.tool")}
          {stats && <EditStats operation={operation ?? "Edit"} stats={stats} />}
        </span>
        <span className="min-w-0 flex-1 truncate text-bone-faint">{command}</span>
        <button onClick={() => setOpen(true)} className="shrink-0 typo-code-snippet text-bone-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-fel-bright">
          {t("session.chat.details")}
        </button>
      </div>
      {open && <ToolDetailsModal name={name} input={input} command={command} result={result} t={t} onClose={() => setOpen(false)} />}
    </div>
  );
}

type DiffLine = {
  kind: "context" | "remove" | "add";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export function editStats(lines: DiffLine[] | null): { added: number; removed: number } | null {
  if (!lines) return null;
  return lines.reduce((counts, line) => {
    if (line.kind === "add") counts.added++;
    if (line.kind === "remove") counts.removed++;
    return counts;
  }, { added: 0, removed: 0 });
}

type EditOperation = "Create" | "Delete" | "Edit";

function normalizedChangeKind(change: Record<string, unknown>): string | null {
  const rawKind = change.kind;
  if (typeof rawKind === "string") return rawKind.trim().toLowerCase();
  if (rawKind && typeof rawKind === "object") {
    const type = (rawKind as Record<string, unknown>).type;
    if (typeof type === "string") return type.trim().toLowerCase();
  }
  return null;
}

function operationFromKind(kind: string | null): EditOperation | null {
  if (kind === "add" || kind === "create" || kind === "added") return "Create";
  if (kind === "delete" || kind === "remove" || kind === "deleted") return "Delete";
  if (kind === "update" || kind === "edit" || kind === "rename") return "Edit";
  return null;
}

export function editOperation(input: unknown): EditOperation {
  if (!input || typeof input !== "object") return "Edit";
  const value = input as Record<string, unknown>;
  if (Array.isArray(value.changes) && value.changes.length > 0) {
    const operations = value.changes.map((rawChange) => {
      if (!rawChange || typeof rawChange !== "object") return null;
      return operationFromKind(normalizedChangeKind(rawChange as Record<string, unknown>));
    });
    if (operations.every((operation) => operation === "Create")) return "Create";
    if (operations.every((operation) => operation === "Delete")) return "Delete";
    if (operations.some(Boolean)) return "Edit";
  }

  const patch = value.patch ?? value.diff;
  if (typeof patch === "string") {
    if (/^\*\*\* Add File:/m.test(patch) || /^---\s+\/dev\/null\s*$/m.test(patch)) return "Create";
    if (/^\*\*\* Delete File:/m.test(patch) || /^\+\+\+\s+\/dev\/null\s*$/m.test(patch)) return "Delete";
  }
  return "Edit";
}

function statsFromDiff(diff: string, operation: EditOperation): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const hunks: Array<{ oldLength: number; newLength: number }> = [];
  const lines = diff.split("\n");
  for (const line of lines) {
    const hunk = /^@@ -(?:\d+)(?:,(\d+))? \+(?:\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      hunks.push({ oldLength: hunk[1] === undefined ? 1 : Number(hunk[1]), newLength: hunk[2] === undefined ? 1 : Number(hunk[2]) });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  const patchLike = hunks.length > 0
    || lines.some((line) => /^\*\*\* (?:Add|Delete|Update) File:/.test(line))
    || (lines.some((line) => /^--- (?:\/dev\/null|[ab]\/)/.test(line)) && lines.some((line) => /^\+\+\+ (?:\/dev\/null|[ab]\/)/.test(line)));

  // Current Codex app-server sends a new/deleted file's complete contents in
  // `diff`, without unified-diff prefixes. Older builds sent a patch instead.
  // Patch markers mean the latter; otherwise count raw contents directly.
  if (operation === "Create" && !patchLike) return { added: contentLineCount(diff), removed: 0 };
  if (operation === "Delete" && !patchLike) return { added: 0, removed: contentLineCount(diff) };

  // Some builds emit only hunk metadata for whole-file creates/deletes. Those
  // ranges are exact because the opposite side is empty.
  if (operation === "Create" && added === 0) {
    added = hunks.reduce((count, hunk) => count + (hunk.oldLength === 0 ? hunk.newLength : 0), 0);
  }
  if (operation === "Delete" && removed === 0) {
    removed = hunks.reduce((count, hunk) => count + (hunk.newLength === 0 ? hunk.oldLength : 0), 0);
  }
  return { added, removed };
}

function contentLineCount(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

export function editStatsFromInput(input: unknown): { added: number; removed: number } | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const operation = editOperation(input);
  if (Array.isArray(value.changes)) {
    let added = 0;
    let removed = 0;
    let foundDiff = false;
    for (const rawChange of value.changes) {
      if (!rawChange || typeof rawChange !== "object") continue;
      const diff = (rawChange as Record<string, unknown>).diff;
      if (typeof diff !== "string") continue;
      foundDiff = true;
      const stats = statsFromDiff(diff, operation);
      added += stats.added;
      removed += stats.removed;
    }
    if (foundDiff) return { added, removed };
  }
  const oldText = value.old_string;
  const newText = value.new_string;
  if (typeof oldText === "string" && typeof newText === "string") {
    return {
      added: newText === "" ? 0 : newText.split("\n").length,
      removed: oldText === "" ? 0 : oldText.split("\n").length,
    };
  }
  return null;
}

function EditStats({ operation, stats }: { operation: EditOperation; stats: { added: number; removed: number } }) {
  return (
    <span className="ml-0.5 typo-code-snippet font-normal">
      ({operation !== "Delete" && <span className="text-fel-bright">+{stats.added}</span>}
      {operation === "Edit" && ","}
      {operation !== "Create" && <span className="text-blood">−{stats.removed}</span>})
    </span>
  );
}

export function editFileName(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const explicitPath = value.file_path ?? value.filePath ?? value.path ?? value.filename;
  let path = typeof explicitPath === "string" && explicitPath.trim() ? explicitPath.trim() : null;
  let additionalFiles = 0;

  if (!path && Array.isArray(value.changes)) {
    const paths = value.changes
      .map((change) => change && typeof change === "object" ? (change as Record<string, unknown>).path : undefined)
      .filter((candidate): candidate is string => typeof candidate === "string" && !!candidate.trim());
    path = paths[0]?.trim() ?? null;
    additionalFiles = Math.max(0, paths.length - 1);
  }

  if (!path) {
    const patch = value.patch ?? value.diff;
    if (typeof patch === "string") {
      path = patch.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m)?.[1]?.trim()
        ?? patch.match(/^\+\+\+\s+(?:b\/)?(.+)$/m)?.[1]?.trim()
        ?? null;
    }
  }

  if (!path) return null;
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return additionalFiles > 0 ? `${fileName} (+${additionalFiles})` : fileName;
}

export function editDiff(input: unknown): DiffLine[] | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;

  // Codex emits exact per-invocation unified diffs on each changed file.
  if (Array.isArray(value.changes)) {
    const lines: DiffLine[] = [];
    for (const rawChange of value.changes) {
      if (!rawChange || typeof rawChange !== "object") continue;
      const change = rawChange as Record<string, unknown>;
      const path = typeof change.path === "string" ? change.path : "changed file";
      if (typeof change.diff === "string") {
        let oldLine: number | undefined;
        let newLine: number | undefined;
        for (const text of change.diff.split("\n")) {
          const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
          if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            lines.push({ kind: "context", text });
            continue;
          }
          const isHeader = text.startsWith("+++") || text.startsWith("---");
          const kind: DiffLine["kind"] = !isHeader && text.startsWith("+") ? "add" : !isHeader && text.startsWith("-") ? "remove" : "context";
          const numbered = oldLine !== undefined && newLine !== undefined && !isHeader;
          lines.push({
            kind,
            text: kind === "context" ? text : text.slice(1),
            oldLine: numbered && kind !== "add" ? oldLine : undefined,
            newLine: numbered && kind !== "remove" ? newLine : undefined,
          });
          if (numbered && kind !== "add") oldLine = oldLine! + 1;
          if (numbered && kind !== "remove") newLine = newLine! + 1;
        }
      }
      if (change.diffTruncated === true) {
        const originalBytes = typeof change.diffOriginalBytes === "number" ? ` (${change.diffOriginalBytes.toLocaleString()} bytes originally)` : "";
        lines.push({ kind: "context", text: `… diff truncated for ${path}${originalBytes}` });
      }
      if (typeof change.diffUnavailable === "string") {
        lines.push({ kind: "context", text: `Diff unavailable for ${path}: ${change.diffUnavailable}` });
      }
    }
    if (lines.length) return lines;
  }

  const { old_string: oldText, new_string: newText } = value;
  if (typeof oldText !== "string" || typeof newText !== "string") return null;

  const before = oldText.split("\n");
  const after = newText.split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i]![j] = before[i] === after[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push({ kind: "context", text: before[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (j < after.length && (i === before.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) {
      lines.push({ kind: "add", text: after[j]!, newLine: j + 1 });
      j++;
    } else {
      lines.push({ kind: "remove", text: before[i]!, oldLine: i + 1 });
      i++;
    }
  }
  return lines;
}

function ToolDetailsModal({ name, input, command, result, t, onClose }: { name?: string; input?: unknown; command: string; result?: { text: string; error?: boolean }; t: T; onClose: () => void }) {
  const isEdit = !toolHasOutputSection(name);
  const modalName = isEdit ? editFileName(input) ?? name : name;
  const diff = isEdit ? editDiff(input) : null;
  const stats = isEdit ? editStatsFromInput(input) : editStats(diff);
  const jsonOutput = result?.error || !result?.text ? null : prettyJsonOutput(result.text);
  const inputText = (() => {
    if (!isEdit) return command;
    if (input && typeof input === "object") {
      const value = input as Record<string, unknown>;
      const patch = value.patch ?? value.diff;
      if (typeof patch === "string" && patch.trim()) return patch;
      try { return JSON.stringify(input, null, 2); } catch { /* fall through */ }
    }
    return command;
  })();
  const title = (
    <span className="flex min-w-0 items-center gap-2.5">
      {isEdit ? <Pencil size={18} className="shrink-0 text-fel-bright" aria-hidden /> : <Terminal size={18} className="shrink-0 text-fel-bright" aria-hidden />}
      <span className="truncate">{modalName || t("session.chat.tool")}</span>
  {stats && <span className="shrink-0 typo-code-snippet font-normal tracking-normal">(<span className="text-blood">−{stats.removed}</span>,<span className="text-fel-bright">+{stats.added}</span>)</span>}
    </span>
  );
  return (
    <Dialog title={title} onClose={onClose} size="lg">
      <div className="space-y-3">
        {diff ? (
          <div className="-mx-5 max-h-[min(32rem,65vh)] overflow-auto py-1 typo-code-snippet md:-mx-6" aria-label={t("session.chat.changes")}>
              {diff.map((line, index) => (
                <div
                  key={index}
                  className={`grid grid-cols-[1.5rem_3rem_3rem_minmax(0,1fr)] px-5 py-px md:px-6 ${line.kind === "add" ? "bg-fel/15 text-fel-bright" : line.kind === "remove" ? "bg-blood/15 text-blood" : "text-bone-dim"}`}
                >
                  <span className="select-none text-center opacity-70">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
                  <span className="select-none border-r border-iron-700/60 pr-2 text-right tabular-nums text-bone-faint" aria-label={line.oldLine === undefined ? undefined : `Old line ${line.oldLine}`}>{line.oldLine ?? ""}</span>
                  <span className="select-none border-r border-iron-700/60 pr-2 text-right tabular-nums text-bone-faint" aria-label={line.newLine === undefined ? undefined : `New line ${line.newLine}`}>{line.newLine ?? ""}</span>
                  <span className="whitespace-pre-wrap break-words pl-3">{line.text || " "}</span>
                </div>
              ))}
          </div>
        ) : (
          <section className="surface surface--inset overflow-hidden">
            <div className="flex items-center gap-2 border-b border-iron-800 bg-iron-900/70 px-3.5 py-2.5 font-display text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-bone-dim">
              <span className="text-fel-bright" aria-hidden>›_</span>{t("session.chat.command")}
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3.5 typo-code-snippet leading-relaxed text-bone-dim">{inputText || "—"}</pre>
          </section>
        )}
        {toolHasOutputSection(name) && <section className={`surface surface--inset overflow-hidden ${result?.error ? "border-blood/35" : ""}`}>
          <div className="flex items-center gap-2 border-b border-iron-800 bg-iron-900/70 px-3.5 py-2.5 font-display text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-bone-dim">
            <span className={result?.error ? "text-blood" : "text-forge"} aria-hidden>↳</span>{t("session.chat.output")}
          </div>
          {jsonOutput !== null ? (
            <HighlightedCode
              source={jsonOutput}
              language="json"
              className="max-h-72 !rounded-none !border-0 !bg-transparent !p-3.5 !text-[0.75rem]"
            />
          ) : (
              <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words p-3.5 typo-code-snippet leading-relaxed ${result?.error ? "text-blood" : "text-bone-dim"}`}>
                {result?.text?.trim() ? result.text : t("session.chat.noOutput")}
              </pre>
          )}
        </section>}
      </div>
    </Dialog>
  );
}

function ActionResult({ text, error, t }: { text: string; error?: boolean; t: T }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 300;
  const shown = open || !long ? text : text.slice(0, 300) + "…";
  if (!text.trim()) return null;
  return (
      <div className="flex justify-start">
      <div className={`max-w-[85%] border-l-2 pl-3 typo-code-snippet ${error ? "border-blood/60 text-blood" : "border-iron-700 text-bone-faint"}`}>
        <pre className="whitespace-pre-wrap break-words">{shown}</pre>
        {long && (
          <button onClick={() => setOpen(!open)} className="mt-1 text-bone-dim transition-colors hover:text-fel-bright">
            {open ? t("session.chat.less") : t("session.chat.more")}
          </button>
        )}
      </div>
    </div>
  );
}

function Thinking({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
      <div className="flex justify-start">
      <div className="max-w-[85%] typo-code-snippet">
        <button onClick={() => setOpen(!open)} className="text-bone-faint transition-colors hover:text-bone-dim">
          ✦ {orcishThinkingLabel(`chat-thinking:${text}`)} {open ? "▾" : "▸"}
        </button>
        {open && <pre className="mt-1 whitespace-pre-wrap break-words border-l-2 border-iron-800 pl-3 italic text-bone-faint">{text}</pre>}
      </div>
    </div>
  );
}

interface PreviewRequest {
  path: string;
  author?: string;
  createdAt?: number;
}

export function ItemView({ item, t, locale = "en", yesterdayLabel = "Yesterday", onOpenPreview, onOpenAttachment, onOpenProjectFile, projectViewer }: { item: Item; t: T; locale?: Locale; yesterdayLabel?: string; onOpenPreview?: (preview: PreviewRequest) => void; onOpenAttachment?: (attachment: MessageAttachment) => void; onOpenProjectFile?: (path: string, viewerUrl: string) => void; projectViewer?: ProjectViewerContext | null }) {
  switch (item.kind) {
    case "user":
      return <UserBubble text={item.text} author={item.author} authorEmail={item.authorEmail} authorGithubLogin={item.authorGithubLogin} authorAvatarUrl={item.authorAvatarUrl} attachments={item.attachments} createdAt={item.createdAt} onOpenAttachment={onOpenAttachment} />;
    case "text":
      return (
        <div className="typo-chat-message leading-relaxed text-bone">
          <Markdown
            source={item.text}
            onOpenFile={(path) => onOpenPreview?.({ path })}
            transformLink={projectViewer ? (href) => projectViewerHref(href, projectViewer) : undefined}
            onOpenLink={projectViewer && onOpenProjectFile ? (href) => {
              const path = projectViewerRelativePath(href, projectViewer);
              if (!path) return false;
              onOpenProjectFile(path, href);
              return true;
            } : undefined}
          />
          {(item.createdAt || item.resultMeta) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-body text-[0.65rem] leading-tight text-bone-faint">
              {item.createdAt && <LocalMessageTime createdAt={item.createdAt} locale={locale} yesterdayLabel={yesterdayLabel} />}
              {item.createdAt && item.resultMeta && <span aria-hidden>·</span>}
              {item.resultMeta && <span className={item.resultMeta.tone === "error" ? "text-blood" : undefined}>{item.resultMeta.text}</span>}
            </div>
          )}
        </div>
      );
    case "thinking":
      return <Thinking text={item.text} />;
    case "tool":
      return <ToolRow name={item.name} input={item.input} result={item.result} t={t} />;
    case "loose":
      return <ActionResult text={item.text} t={t} />;
    case "notice":
      return <Notice tone={item.tone}>{item.text}</Notice>;
    case "preview":
      return (
        <div className="flex justify-start">
          <div className="flex min-w-0 max-w-[85%] items-center gap-2 rounded-md border border-fel-deep/50 bg-fel/[0.07] px-3 py-2">
            <span aria-hidden className="text-fel-bright">▣</span>
            <div className="min-w-0 flex-1">
              <div className="truncate typo-code-snippet text-bone" title={item.path}>{item.path.split(/[\\/]/).pop() || item.path}</div>
              <div className="typo-code-snippet text-bone-faint">{item.author ? `${item.author} · ` : ""}{item.createdAt ? new Date(item.createdAt).toLocaleString() : ""}</div>
            </div>
            <button type="button" className="shrink-0 typo-code-snippet text-fel-bright underline decoration-dotted underline-offset-2 hover:text-bone" onClick={() => onOpenPreview?.(item)}>
              {t("session.preview.open")}
            </button>
          </div>
        </div>
      );
    case "raw":
      return item.text ? <div className="whitespace-pre-wrap break-words typo-code-snippet text-bone-faint">{item.text}</div> : null;
  }
}

export function Working({
  label,
  startedAt,
  model,
  effort,
  onStop,
  stopping,
  stopLabel,
  stoppingLabel,
}: {
  // Absent while the agent is merely thinking — there is nothing concrete to
  // report, so the row shows the run's model and effort instead of filler text.
  label?: string | null;
  startedAt?: number;
  model?: string | null;
  effort?: string | null;
  onStop: () => void;
  stopping: boolean;
  stopLabel: string;
  stoppingLabel: string;
}) {
  const fallbackStartedAt = useRef(Date.now());
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  const effectiveStartedAt = typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0 && startedAt <= now
    ? startedAt
    : fallbackStartedAt.current;
  const duration = formatStepDuration(now - effectiveStartedAt);
  return (
    <div className="reveal flex items-center justify-start gap-2 typo-code-snippet text-bone-faint">
      <span className="thinking-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {label && <span>{label}</span>}
      <span className="tabular-nums text-bone-dim">{label ? "· " : ""}{duration}</span>
      {model && <span className="text-bone-dim">· {model}</span>}
      {effort && <span className="text-bone-dim">· {effort}</span>}
      <button
        type="button"
        data-session-stop-control
        className="flex items-center gap-1 text-ember transition-colors hover:text-blood disabled:opacity-40"
        onClick={onStop}
        disabled={stopping}
      >
        <span className="text-[0.6rem] leading-none" aria-hidden>■</span>
        {stopping ? stoppingLabel : stopLabel}
      </button>
    </div>
  );
}

export function formatStepDuration(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}:${seconds.toString().padStart(2, "0")}`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
