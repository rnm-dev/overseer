import type { ReactNode } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Hourglass, Zap } from "lucide-react";
import { useT } from "../../shared/i18n";
import type { MessageAttachment } from "./parsing";
import { isLongPastedText, isPastedTextName, pastedTextFile } from "./pastedText";
import type { SelectedTextReply } from "./selectedTextReply";
import { SelectedTextReplyCard } from "./SelectedTextReplyCard";

// author: Viktor
// The prompt box shared by PeonNewSession (starting a session) and
// PeonSessionDetail (following up on one). Textarea, attachments, and the
// bottom toolbar row live here; callers own the actual submit + model/agent
// pickers via leftExtra/rightExtra so this stays agnostic of what it starts.

// Types the peon presents as visual content via the agent's Read tool → sent as
// { type: "image" }. Everything else is a { type: "file" } the agent Reads as text.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
// Keep in sync with the textarea's `max-h-40` (10rem) — the auto-size effect
// caps the grown height and the class caps the painted one.
export const MAX_TEXTAREA_HEIGHT = 160;
const isImage = (f: File) => IMAGE_TYPES.has(f.type);
// Friendly chip label — pasted screenshots and text have a machine name; show a short one.
const chipName = (f: File) => (isPastedTextName(f.name) ? "Pasted text" : /^pasted-\d+/.test(f.name) ? "Pasted image" : f.name);
// An attachment the draft carries by path was committed on the peon before this
// composer ever saw it, so there are no bytes here to name it by.
export const carriedName = (attachment: MessageAttachment): string =>
  attachment.name || attachment.path?.split(/[\\/]/).filter(Boolean).pop() || "file";

export const COMPOSER_CHIP_CLASS = "flex items-center gap-1.5 rounded-md border border-edge-strong bg-surface py-1 pl-1.5 pr-2 font-mono text-xs text-ink-muted";

export function isFileDrag(types: ArrayLike<string>): boolean {
  return Array.from(types).includes("Files");
}

export function supportsDesktopComposerFocus(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean } };
  // Keep phones/tablets from summoning the software keyboard when a composer
  // mounts, including when a connected mouse makes their primary pointer fine.
  if (nav.userAgentData?.mobile || /Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)) return false;
  return typeof window.matchMedia === "function"
    ? window.matchMedia("(min-width: 768px) and (hover: hover) and (pointer: fine)").matches
    : window.innerWidth >= 768;
}

export const COMPOSER_SHELL_CLASS = "surface theme-composer-shell composer-shell relative p-2 transition-[border-color,box-shadow]";
export const COMPOSER_ICON_ACTION_CLASS = "on-surface on-surface--interactive flex h-8 w-8 flex-none items-center justify-center rounded-lg";
export const COMPOSER_TEXT_ACTION_CLASS = "on-surface on-surface--interactive h-8 flex-none rounded-lg px-3";

export interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  submitTitle: string;
  submitIcon?: "send" | "queue";
  // True while the current prompt is in flight — locks input and spins the send button.
  disabled: boolean;
  pending?: boolean;
  autoFocus?: boolean;
  files: File[];
  onFilesChange: (files: File[]) => void;
  // Attachments the draft carries by path instead of by bytes — a queued
  // message pulled back in for editing brings its own along.
  carried?: MessageAttachment[];
  onCarriedChange?: (carried: MessageAttachment[]) => void;
  onPreviewFile: (url: string) => void;
  filesEnabled: boolean | null;
  // Local input/attachment validation stays next to the field. Failed remote
  // actions are surfaced by the global notifications hook instead.
  error: string | null;
  onErrorChange: (msg: string | null) => void;
  replyTo?: SelectedTextReply | null;
  onClearReplyTo?: () => void;
  onOpenReplySource?: (replyTo: SelectedTextReply) => void;
  leftExtra?: ReactNode;
  rightExtra?: ReactNode;
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean; pending?: boolean; mobileIcon?: "zap" };
}

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  submitTitle,
  submitIcon = "send",
  disabled,
  pending = disabled,
  autoFocus,
  files,
  onFilesChange,
  carried = [],
  onCarriedChange,
  onPreviewFile,
  filesEnabled,
  error,
  onErrorChange,
  replyTo = null,
  onClearReplyTo,
  onOpenReplySource,
  leftExtra,
  rightExtra,
  secondaryAction,
}: ComposerProps) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const canSubmit = !disabled && Boolean(value.trim() || files.length || carried.length);
  // Object URLs for image thumbnails; revoked when the file set changes/unmounts.
  const previews = useMemo(() => files.map((f) => (isImage(f) ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);
  // Size the textarea to its content on every value change, not just while
  // typing: a draft restored from storage, a session switch, and a programmatic
  // clear after submit all land at the right height with no intermediate frame
  // at the single-row default.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (value) el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [value]);

  function submit() {
    onSubmit();
    // Clicking the send button moves focus away from the textarea. Put it back
    // on desktop so typing can continue immediately; blur explicitly on mobile
    // so its software keyboard closes after sending.
    if (autoFocus) textareaRef.current?.focus();
    else textareaRef.current?.blur();
  }

  function addFiles(picked: File[]) {
    const ok = picked.filter((f) => f.size <= MAX_FILE_BYTES);
    onFilesChange([...files, ...ok].slice(0, MAX_FILES));
    onErrorChange(ok.length < picked.length ? t("session.compose.tooLarge") : files.length + ok.length > MAX_FILES ? t("session.compose.tooMany") : null);
  }

  function resetDrag() {
    dragDepthRef.current = 0;
    setDragActive(false);
  }

  return (
    <div
      data-file-drop-zone="composer"
      className={`${COMPOSER_SHELL_CLASS} ${dragActive ? "border-accent bg-accent/10" : ""}`}
      onDragEnter={(event) => {
        if (!isFileDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        if (!disabled) setDragActive(true);
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled ? "none" : "copy";
      }}
      onDragLeave={() => {
        if (dragDepthRef.current === 0) return;
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDragActive(false);
      }}
      onDrop={(event) => {
        if (!isFileDrag(event.dataTransfer.types)) return;
        event.preventDefault();
        resetDrag();
        if (disabled) return;
        if (!filesEnabled) return onErrorChange(t("session.compose.filesDisabledHint"));
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {dragActive && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-surface/90 px-4 text-center font-mono text-xs font-semibold text-accent-strong" role="status">
          {filesEnabled ? t("session.compose.dropFiles") : t("session.compose.filesDisabled")}
        </div>
      )}
      {error && <div className="px-2 pb-1 pt-0.5 font-mono text-xs text-danger">⚠ {error}</div>}
      {replyTo && (
        <div className="px-1 pb-1.5 pt-1">
          <SelectedTextReplyCard replyTo={replyTo} onClear={onClearReplyTo} onOpenSource={onOpenReplySource ? () => onOpenReplySource(replyTo) : undefined} />
        </div>
      )}
      {(files.length > 0 || carried.length > 0) && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-1.5 pt-1">
          {carried.map((attachment, i) => (
            <span key={`carried:${attachment.path}:${i}`} className={COMPOSER_CHIP_CLASS}>
              <span className="shrink-0 text-ink-faint" aria-hidden>📎</span>
              <span className="max-w-[130px] truncate" title={attachment.path}>{carriedName(attachment)}</span>
              <button
                type="button"
                className="shrink-0 text-ink-faint transition-colors hover:text-danger"
                title={t("session.compose.removeAttachment")}
                aria-label={t("session.compose.removeAttachment")}
                onClick={() => onCarriedChange?.(carried.filter((_, j) => j !== i))}
                disabled={disabled || !onCarriedChange}
              >
                ×
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <span key={i} className={COMPOSER_CHIP_CLASS}>
              {previews[i] ? (
                <button type="button" title={t("session.compose.preview")} onClick={() => onPreviewFile(previews[i]!)} className="block h-4 w-4 shrink-0 overflow-hidden rounded-sm">
                  <img src={previews[i]!} alt="" className="h-full w-full object-cover" />
                </button>
              ) : (
                <svg className="shrink-0 text-ink-faint" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                  <path d="M14 2v6h6" />
                </svg>
              )}
              <span className="max-w-[130px] truncate" title={f.name}>{chipName(f)}</span>
              <button className="shrink-0 text-ink-faint transition-colors hover:text-danger" onClick={() => onFilesChange(files.filter((_, j) => j !== i))} disabled={disabled}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <textarea
        ref={textareaRef}
        className="composer-input max-h-40 min-h-8 w-full resize-none bg-transparent px-1 py-1 font-body leading-normal text-ink placeholder:text-ink-faint focus:outline-none"
        rows={1}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        disabled={disabled && !autoFocus}
        readOnly={disabled && Boolean(autoFocus)}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={(e) => {
          const dt = e.clipboardData;
          const pasted: File[] = [];
          if (dt.files.length) pasted.push(...Array.from(dt.files));
          else for (const it of Array.from(dt.items)) if (it.kind === "file") { const f = it.getAsFile(); if (f) pasted.push(f); }
          if (!pasted.length) {
            // Plain text: a wall of it goes in as a file so the message stays
            // readable. Short pastes — and any paste we could not attach — go
            // into the textarea as usual.
            const text = dt.getData("text/plain");
            if (!text || !isLongPastedText(text)) return;
            if (!filesEnabled || files.length >= MAX_FILES) return;
            e.preventDefault();
            addFiles([pastedTextFile(text, Date.now(), files.length)]);
            return;
          }
          e.preventDefault();
          // Screenshots arrive as generic "image.png" — give them unique names so multiple don't collide on upload.
          addFiles(pasted.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now()}-${i}.${(f.type.split("/")[1] || "bin").replace("jpeg", "jpg")}`, { type: f.type }))));
        }}
      />
      <div className="composer-toolbar flex flex-wrap items-center justify-between gap-1.5 pt-1">
        <div className="composer-toolbar-left flex min-w-0 flex-wrap items-center gap-1.5">
          <button
            type="button"
            title={filesEnabled ? t("session.compose.attach") : t("session.compose.filesDisabled")}
            disabled={disabled}
            onClick={() => {
              if (!filesEnabled) return onErrorChange(t("session.compose.filesDisabledHint"));
              onErrorChange(null);
              fileInputRef.current?.click();
            }}
            className={`${COMPOSER_ICON_ACTION_CLASS} text-ink-faint hover:text-accent-strong disabled:opacity-30`}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M5 12h14" />
              <path d="M12 5v14" />
            </svg>
          </button>
          {leftExtra}
        </div>
        <div className="composer-toolbar-right flex min-w-0 flex-wrap items-center justify-end gap-1.5">
          {rightExtra}
          {secondaryAction && (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              disabled={disabled || secondaryAction.disabled}
              title={secondaryAction.label}
              aria-label={secondaryAction.label}
              className={`${secondaryAction.mobileIcon ? `${COMPOSER_ICON_ACTION_CLASS} sm:w-auto sm:px-3` : COMPOSER_TEXT_ACTION_CLASS} font-mono text-xs text-ink-muted hover:text-warning-strong disabled:cursor-wait disabled:opacity-40`}
            >
              {secondaryAction.pending ? "…" : secondaryAction.mobileIcon === "zap" ? (
                <>
                  <Zap size={16} className="sm:hidden" aria-hidden />
                  <span className="hidden sm:inline">{secondaryAction.label}</span>
                </>
              ) : secondaryAction.label}
            </button>
          )}
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            title={submitTitle}
            className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors ${canSubmit ? "bg-accent text-on-accent hover:bg-accent-strong" : "on-surface text-ink-faint"}`}
          >
            {pending ? (
              <span className="block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : submitIcon === "queue" ? (
              <Hourglass size={16} aria-hidden />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 10 4 15l5 5" />
                <path d="M20 4v7a4 4 0 0 1-4 4H4" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
