import { memo, useRef, useState, type ReactNode } from "react";
import { useNow } from "../../shared/useNow";
import { Dialog } from "../../shared/ui";
import { HighlightedCode, Markdown } from "../../shared/RichText";
import { orcishThinkingLabel, prettyJsonOutput, toolHasOutputSection, toolSummary, type Item, type MessageAttachment, type T } from "./parsing";
import { Avatar } from "../../shared/Avatar";
import { Bot, FilePenLine, FileText, Globe2, ImageIcon, Paperclip, Pencil, Search, Terminal, Wrench } from "lucide-react";
import { projectViewerHref, projectViewerRelativePath, type ProjectViewerContext } from "../projects/projectViewerLink";
import { useAuth, type User } from "../auth/auth";
import { useI18n, type Locale } from "../../shared/i18n";
import { formatLocalTimestamp, localeTag } from "../../shared/timeFormat";
import type { SelectedTextReply } from "./selectedTextReply";
import { SelectedTextReplyCard } from "./SelectedTextReplyCard";
import type { ComposerMention, MentionPrincipal } from "./contextMentions";
import { editDiff, editFileName, editOperation, editStats, editStatsFromInput, type EditOperation } from "./toolEdit";
import { simpleToolFileName, simpleToolKind, type SimpleToolKind } from "./simpleTools";

// The transcript render atoms: one component per Item kind, plus the Markdown
// renderer and the "agent is working" indicator. Pure presentation — all parsing
// lives in ./parsing. author: Viktor

const OWN_ATTACHMENT_CLASS = "theme-user-message-ink bg-surface/25 hover:bg-surface/40";
const OTHER_ATTACHMENT_CLASS = "on-surface text-ink hover-wash";
const TOOL_ROW_LAYOUT_CLASS = "grid w-fit min-w-0 max-w-[85%] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-1.5 py-0.5 typo-chat-system-message";
const TOOL_ROW_CLASS = `${TOOL_ROW_LAYOUT_CLASS} rounded text-left transition-colors hover-wash hover:text-ink`;
// The 2px rule under a tool row is centered on that row's size-4 icon column ((16-2)/2 = 7px),
// and its text resumes where the row's label does (16px icon + gap-x-1.5 - 7px - 2px = 13px).
export const TOOL_DETAIL_RULE_CLASS = "ml-[7px] border-l-2 pl-[13px]";

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
  const iconClass = `grid h-7 w-7 shrink-0 place-items-center rounded-md ${mine ? "theme-user-message-icon" : "bg-warning/10 text-warning"}`;
  const contents = <>
      <span className={iconClass} aria-hidden>
        {attachment.type === "image" ? <ImageIcon size={14} /> : <Paperclip size={14} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-display text-xs font-semibold">{label}</span>
        <span className={`mt-0.5 block font-mono text-[0.625rem] leading-none ${mine ? "theme-user-message-meta" : "text-ink-faint"}`}>{attachmentMeta(attachment)}</span>
      </span>
    </>;
  return onOpen ? <button type="button" className={`${className} cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${mine ? "theme-user-message-focus" : "focus-visible:ring-accent/60"}`} title={attachment.path || label} onClick={onOpen}>{contents}</button>
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

const USER_BUBBLE_BASE_CLASS = "max-w-[80%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm px-3 py-1.5 typo-chat-message text-ink";
const OWN_USER_BUBBLE_CLASS = `${USER_BUBBLE_BASE_CLASS} theme-user-message`;
const OTHER_USER_BUBBLE_CLASS = `${USER_BUBBLE_BASE_CLASS} surface`;
const OTHER_USER_BUBBLE_AUTHOR_CLASS = "mb-1 truncate font-body text-[0.625rem] font-semibold leading-tight text-accent-strong";
const OWN_USER_BUBBLE_TIME_CLASS = "theme-user-message-meta font-body text-[0.625rem] leading-tight";
const OTHER_USER_BUBBLE_TIME_CLASS = "font-body text-[0.625rem] leading-tight text-ink-faint";

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

// Overseer's snapshot label for an authenticated person is their GitHub login or
// email, which is exactly what identifies the signed-in user here. The opaque
// principal id is Overseer's own identity and is deliberately not compared.
export function isOwnParticipantAuthor(user: User | null, author: MentionPrincipal): boolean {
  return author.kind === "user" && isOwnMessageAuthor(user, undefined, undefined, author.label);
}

// The authoritative ranges make a person's name visible in the transcript, the
// same tokens the composer colored. Text is never rewritten from the current
// label: the range is what makes those exact characters a mention.
export function MentionedText({ text, mentions, user }: { text: string; mentions?: ComposerMention[]; user: User | null }) {
  if (!mentions?.length) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const [index, mention] of mentions.entries()) {
    const start = mention.startUtf16;
    const end = start + mention.lengthUtf16;
    if (start < cursor || end > text.length) continue;
    nodes.push(text.slice(cursor, start));
    nodes.push(
      <span
        key={`${index}:${start}`}
        title={mention.principal.label}
        className={isOwnParticipantAuthor(user, mention.principal)
          ? "rounded-sm bg-warning/20 font-semibold text-warning-strong"
          : "rounded-sm bg-accent/15 text-accent-strong"}
      >{text.slice(start, end)}</span>,
    );
    cursor = end;
  }
  nodes.push(text.slice(cursor));
  return <>{nodes}</>;
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

export function UserBubble({ own, text, mentions, replyTo, author, authorEmail, authorGithubLogin, authorAvatarUrl, attachments, createdAt, onOpenAttachment, onOpenReplySource }: { own?: boolean; text: string; mentions?: ComposerMention[]; replyTo?: SelectedTextReply; author?: string; authorEmail?: string; authorGithubLogin?: string; authorAvatarUrl?: string; attachments?: MessageAttachment[]; createdAt?: number; onOpenAttachment?: (attachment: MessageAttachment) => void; onOpenReplySource?: (replyTo: SelectedTextReply) => void }) {
  const { user } = useAuth();
  const { locale, t } = useI18n();
  const mine = own ?? isOwnMessageAuthor(user, authorEmail, authorGithubLogin, author);
  const compact = isCompactUserMessage(text, attachments);
  const displayAuthor = authorGithubLogin || authorEmail || author;
  const avatarLabel = displayAuthor || "Unknown message author";
  const avatarUrl = userMessageAvatar(mine ? user : null, authorAvatarUrl, authorEmail, authorGithubLogin, author);
  return (
    <div className="flex items-end justify-end gap-2 py-3">
      <div className={mine ? OWN_USER_BUBBLE_CLASS : OTHER_USER_BUBBLE_CLASS}>
        {!mine && displayAuthor && <div className={OTHER_USER_BUBBLE_AUTHOR_CLASS} title={displayAuthor}>{displayAuthor}</div>}
        {replyTo && <div className="mb-2"><SelectedTextReplyCard replyTo={replyTo} compact onOpenSource={() => onOpenReplySource?.(replyTo)} /></div>}
        {compact ? (
          <div className="flex items-end gap-3">
            <div className="min-w-0 flex-1"><MentionedText text={text} mentions={mentions} user={user} /></div>
            {createdAt && <div className={`${mine ? OWN_USER_BUBBLE_TIME_CLASS : OTHER_USER_BUBBLE_TIME_CLASS} shrink-0 pb-px`}><LocalMessageTime createdAt={createdAt} locale={locale} yesterdayLabel={t("peon.stats.period.yesterday")} /></div>}
          </div>
        ) : text ? <div><MentionedText text={text} mentions={mentions} user={user} /></div> : null}
        {!!attachments?.length && (
          <div className={text ? "mt-2 grid gap-1" : "grid gap-1"}>
            {attachments.map((attachment, i) => <AttachmentPill key={`${attachment.path || attachment.name || "attachment"}-${i}`} attachment={attachment} mine={mine} onOpen={attachment.path ? () => onOpenAttachment?.(attachment) : undefined} />)}
          </div>
        )}
        {createdAt && !compact && <div className={`${mine ? OWN_USER_BUBBLE_TIME_CLASS : OTHER_USER_BUBBLE_TIME_CLASS} mt-1 text-right`}><LocalMessageTime createdAt={createdAt} locale={locale} yesterdayLabel={t("peon.stats.period.yesterday")} /></div>}
      </div>
      <Avatar src={avatarUrl} label={avatarLabel} className="border-accent/35 bg-accent/15 text-accent-strong" />
    </div>
  );
}

export function ParticipantBubble({ item, onOpenAttachment }: { item: Extract<Item, { kind: "participant" }>; onOpenAttachment?: (attachment: MessageAttachment) => void }) {
  const { user } = useAuth();
  return (
    <UserBubble
      own={isOwnParticipantAuthor(user, item.author)}
      text={item.text}
      mentions={item.mentions}
      author={item.author.label}
      attachments={item.attachments}
      createdAt={item.createdAt}
      onOpenAttachment={onOpenAttachment}
    />
  );
}

// Session-summary strip for a turn that ended without a closing assistant
// message — an interrupted run, say. When there is one, the summary is attached
// to that message's meta line instead (parsing.ts), so this row always follows
// something else and takes the list's ordinary gap: a negative margin here
// printed it on top of the preceding row.
function Notice({ tone, children }: { tone?: "neutral" | "error"; children: ReactNode }) {
  return (
    <div className={`flex justify-start typo-chat-system-message ${tone === "error" ? "text-danger" : "text-ink-faint"}`}>{children}</div>
  );
}

// A tool call collapsed to a single clipped line — icon, name, clipped command —
// with a Details button that opens the full command + output in a modal. Command
// output is never shown inline; it's noise unless the operator asks for it.
function ToolRow({ name, input, result, t, simple = false }: { name?: string; input?: unknown; result?: { text: string; error?: boolean }; t: T; simple?: boolean }) {
  const [open, setOpen] = useState(false);
  const command = toolSummary(input, name);
  const failed = !!result?.error;
  const isEdit = !toolHasOutputSection(name);
  const operation = isEdit ? editOperation(input) : null;
  const stats = isEdit ? editStatsFromInput(input) : null;
  const activityKind = simpleToolKind(name);
  const activityLabel = t(`session.chat.activity.${activityKind}`);
  const activityFile = simpleToolFileName(name, input);
  const activityText = activityFile ? `${activityLabel} · ${activityFile}` : activityLabel;
  const activityStatus = failed
    ? t("session.chat.activity.failed")
    : result
      ? t("session.chat.activity.complete")
      : t("session.chat.activity.running");

  // One row, one set of styles. The technical mode differs only in its words: the
  // operation's own name sits beside the icon and the row carries the raw command
  // instead of the plain-language activity. Layout, colours, the status the icon
  // reports and the details modal are shared, so the two modes cannot drift apart.
  const operationName = operation ?? name ?? t("session.chat.tool");
  const hint = simple ? t("session.chat.activity.showTechnical") : t("session.chat.details");
  return (
    <div className="flex justify-start">
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={hint}
        aria-label={`${simple ? activityText : `${operationName} ${command}`}. ${activityStatus}. ${hint}`}
        data-tool-kind={activityKind}
        className={`${TOOL_ROW_CLASS} ${failed ? "text-danger" : "text-ink-faint"}`}
      >
        <span className={`grid size-4 place-items-center ${failed ? "text-danger" : result ? "text-accent-strong" : "animate-pulse text-warning-strong"}`} aria-hidden>
          <SimpleToolIcon kind={activityKind} />
        </span>
        {simple ? (
          <span className="min-w-0 truncate">{activityText}</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0">
              {operationName}
              {stats && <EditStats operation={operation ?? "Edit"} stats={stats} />}
            </span>
            <span className="min-w-0 truncate">{command}</span>
          </span>
        )}
        {failed && <span className="shrink-0 text-danger">· {t("session.chat.activity.failedShort")}</span>}
      </button>
      {open && <ToolDetailsModal name={name} input={input} command={command} result={result} t={t} onClose={() => setOpen(false)} />}
    </div>
  );
}

// What a subagent did inside its Agent call, indented under that row. Open
// while it runs so progress is visible; folded once its result lands.
function SubagentSteps({ items, running, t, render }: { items: Item[]; running: boolean; t: T; render: (item: Item) => ReactNode }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? running;
  return (
    <div className="ml-2 mt-1 border-l border-edge pl-3">
      <button
        type="button"
        onClick={() => setOpen(!expanded)}
        aria-expanded={expanded}
        className="typo-chat-system-message text-ink-faint hover:text-ink"
      >
        {expanded ? "▾" : "▸"} {t("session.chat.subagentSteps", { n: items.length })}
      </button>
      {expanded && <div className="mt-1 flex flex-col gap-1.5">{items.map((child) => <div key={child.key}>{render(child)}</div>)}</div>}
    </div>
  );
}

function EditStats({ operation, stats }: { operation: EditOperation; stats: { added: number; removed: number } }) {
  return (
    <span className="ml-0.5 typo-chat-system-message font-normal">
      ({operation !== "Delete" && <span className="text-accent-strong">+{stats.added}</span>}
      {operation === "Edit" && ","}
      {operation !== "Create" && <span className="text-danger">−{stats.removed}</span>})
    </span>
  );
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
      {isEdit ? <Pencil size={18} className="shrink-0 text-accent-strong" aria-hidden /> : <Terminal size={18} className="shrink-0 text-accent-strong" aria-hidden />}
      <span className="truncate">{modalName || t("session.chat.tool")}</span>
  {stats && <span className="shrink-0 typo-chat-system-message font-normal tracking-normal">(<span className="text-danger">−{stats.removed}</span>,<span className="text-accent-strong">+{stats.added}</span>)</span>}
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
                  className={`grid grid-cols-[1.5rem_3rem_3rem_minmax(0,1fr)] px-5 py-px md:px-6 ${line.kind === "add" ? "bg-accent/15 text-accent-strong" : line.kind === "remove" ? "bg-danger/15 text-danger" : "text-ink-muted"}`}
                >
                  <span className="select-none text-center opacity-70">{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</span>
                  <span className="select-none border-r border-edge-strong/60 pr-2 text-right tabular-nums text-ink-faint" aria-label={line.oldLine === undefined ? undefined : `Old line ${line.oldLine}`}>{line.oldLine ?? ""}</span>
                  <span className="select-none border-r border-edge-strong/60 pr-2 text-right tabular-nums text-ink-faint" aria-label={line.newLine === undefined ? undefined : `New line ${line.newLine}`}>{line.newLine ?? ""}</span>
                  <span className="whitespace-pre-wrap break-words pl-3">{line.text || " "}</span>
                </div>
              ))}
          </div>
        ) : (
          <section className="surface surface--inset overflow-hidden">
            <div className="flex items-center gap-2 border-b border-edge bg-surface-raised/70 px-3.5 py-2.5 font-display text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-ink-muted">
              <span className="text-accent-strong" aria-hidden>›_</span>{t("session.chat.command")}
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words p-3.5 typo-code-snippet leading-relaxed text-ink-muted">{inputText || "—"}</pre>
          </section>
        )}
        {toolHasOutputSection(name) && <section className={`surface surface--inset overflow-hidden ${result?.error ? "border-danger/35" : ""}`}>
          <div className="flex items-center gap-2 border-b border-edge bg-surface-raised/70 px-3.5 py-2.5 font-display text-[0.625rem] font-semibold uppercase tracking-[0.18em] text-ink-muted">
            <span className={result?.error ? "text-danger" : "text-warning"} aria-hidden>↳</span>{t("session.chat.output")}
          </div>
          {jsonOutput !== null ? (
            <HighlightedCode
              source={jsonOutput}
              language="json"
              className="max-h-72 !rounded-none !border-0 !bg-transparent !p-3.5 !text-[0.75rem]"
            />
          ) : (
              <pre className={`max-h-72 overflow-auto whitespace-pre-wrap break-words p-3.5 typo-code-snippet leading-relaxed ${result?.error ? "text-danger" : "text-ink-muted"}`}>
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
      <div className={`max-w-[85%] ${TOOL_DETAIL_RULE_CLASS} typo-chat-system-message ${error ? "border-danger/60 text-danger" : "border-edge-strong text-ink-faint"}`}>
        <pre className="whitespace-pre-wrap break-words typo-chat-system-message">{shown}</pre>
        {long && (
          <button onClick={() => setOpen(!open)} className="mt-1 text-ink-muted transition-colors hover:text-accent-strong">
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
      <div className="max-w-[85%] typo-chat-system-message">
        <button onClick={() => setOpen(!open)} className="text-ink-faint transition-colors hover:text-ink-muted typo-chat-system-message">
          ✦ {orcishThinkingLabel(`chat-thinking:${text}`)} {open ? "▾" : "▸"}
        </button>
        {open && (
          <pre className="mt-1 whitespace-pre-wrap break-words border-l-2 border-edge pl-3 italic text-ink-faint typo-chat-system-message">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}

interface PreviewRequest {
  path: string;
  author?: string;
  createdAt?: number;
}

function SimpleToolIcon({ kind }: { kind: SimpleToolKind }) {
  const props = { size: 13, strokeWidth: 1.8 };
  switch (kind) {
    case "read":
      return <FileText {...props} />;
    case "search":
      return <Search {...props} />;
    case "web":
      return <Globe2 {...props} />;
    case "edit":
      return <FilePenLine {...props} />;
    case "analysis":
      return <Bot {...props} />;
    case "command":
      return <Terminal {...props} />;
    default:
      return <Wrench {...props} />;
  }
}

export function ItemView({ item, t, locale = "en", yesterdayLabel = "Yesterday", simpleTools = false, onOpenPreview, onOpenAttachment, onOpenReplySource, onOpenProjectFile, projectViewer }: { item: Item; t: T; locale?: Locale; yesterdayLabel?: string; simpleTools?: boolean; onOpenPreview?: (preview: PreviewRequest) => void; onOpenAttachment?: (attachment: MessageAttachment) => void; onOpenReplySource?: (replyTo: SelectedTextReply) => void; onOpenProjectFile?: (path: string, viewerUrl: string) => void; projectViewer?: ProjectViewerContext | null }) {
  switch (item.kind) {
    case "participant":
      return <ParticipantBubble item={item} onOpenAttachment={onOpenAttachment} />;
    case "user":
      return <UserBubble text={item.text} mentions={item.mentions} replyTo={item.replyTo} author={item.author} authorEmail={item.authorEmail} authorGithubLogin={item.authorGithubLogin} authorAvatarUrl={item.authorAvatarUrl} attachments={item.attachments} createdAt={item.createdAt} onOpenAttachment={onOpenAttachment} onOpenReplySource={onOpenReplySource} />;
    case "text":
      return (
        <div className="typo-chat-message leading-relaxed text-ink">
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
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-body text-[0.625rem] leading-tight text-ink-faint">
              {item.createdAt && <LocalMessageTime createdAt={item.createdAt} locale={locale} yesterdayLabel={yesterdayLabel} />}
              {item.createdAt && item.resultMeta && <span aria-hidden>·</span>}
              {item.resultMeta && <span>{item.resultMeta.text}</span>}
            </div>
          )}
        </div>
      );
    case "thinking":
      return <Thinking text={item.text} />;
    case "tool": {
      const row = <ToolRow name={item.name} input={item.input} result={item.result} t={t} simple={simpleTools} />;
      if (!item.children?.length) return row;
      return (
        <div>
          {row}
          <SubagentSteps items={item.children} running={!item.result} t={t} render={(child) => (
            <ItemView item={child} t={t} locale={locale} yesterdayLabel={yesterdayLabel} simpleTools={simpleTools} onOpenPreview={onOpenPreview} onOpenAttachment={onOpenAttachment} onOpenReplySource={onOpenReplySource} onOpenProjectFile={onOpenProjectFile} projectViewer={projectViewer} />
          )} />
        </div>
      );
    }
    case "loose":
      return <ActionResult text={item.text} t={t} />;
    case "notice":
      return <Notice tone={item.tone}>{item.text}</Notice>;
    case "preview":
      return (
        <div className="flex justify-start">
          <div className="flex min-w-0 max-w-[85%] items-center gap-2 rounded-md border border-accent-deep/50 bg-accent/[0.07] px-3 py-2">
            <span aria-hidden className="text-accent-strong">▣</span>
            <div className="min-w-0 flex-1">
              <div className="truncate typo-code-snippet text-ink" title={item.path}>{item.path.split(/[\\/]/).pop() || item.path}</div>
              <div className="typo-chat-system-message text-ink-faint">{item.author ? `${item.author} · ` : ""}{item.createdAt ? new Date(item.createdAt).toLocaleString() : ""}</div>
            </div>
            <button type="button" className="shrink-0 typo-chat-system-message text-accent-strong underline decoration-dotted underline-offset-2 hover:text-ink" onClick={() => onOpenPreview?.(item)}>
              {t("session.preview.open")}
            </button>
          </div>
        </div>
      );
    case "raw":
      return item.text ? <div className="whitespace-pre-wrap break-words typo-chat-system-message text-ink-faint">{item.text}</div> : null;
  }
}

export const MemoItemView = memo(ItemView);

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
  const now = useNow(1_000);
  const effectiveStartedAt = typeof startedAt === "number" && Number.isFinite(startedAt) && startedAt > 0 && startedAt <= now
    ? startedAt
    : fallbackStartedAt.current;
  const duration = formatStepDuration(now - effectiveStartedAt);
  return (
    <div className="reveal flex items-center justify-start gap-2 typo-chat-system-message text-ink-faint">
      <span className="thinking-dots" aria-hidden>
        <span />
        <span />
        <span />
      </span>
      {label && <span>{label}</span>}
      <span className="tabular-nums text-ink-muted">{label ? "· " : ""}{duration}</span>
      {model && <span className="text-ink-muted">· {model}</span>}
      {effort && <span className="text-ink-muted">· {effort}</span>}
      <button
        type="button"
        data-session-stop-control
        className="flex items-center gap-1 text-warning-strong transition-colors hover:text-danger disabled:opacity-40"
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
