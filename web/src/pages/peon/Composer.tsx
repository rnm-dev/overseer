import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Hourglass, Zap } from "lucide-react";
import { useT } from "../../i18n";

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
const isImage = (f: File) => IMAGE_TYPES.has(f.type);
// Friendly chip label — pasted screenshots have a machine name; show a short one.
const chipName = (f: File) => (/^pasted-\d+/.test(f.name) ? "Pasted image" : f.name);

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

export const COMPOSER_SHELL_CLASS = "surface composer-shell relative p-2 shadow-[0_-6px_28px_-14px_rgba(0,0,0,0.8)] transition-[border-color,box-shadow] focus-within:border-fel-bright focus-within:ring-1 focus-within:ring-fel-bright/55";
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
  onPreviewFile: (url: string) => void;
  filesEnabled: boolean | null;
  // Local input/attachment validation stays next to the field. Failed remote
  // actions are surfaced by the global notifications hook instead.
  error: string | null;
  onErrorChange: (msg: string | null) => void;
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
  onPreviewFile,
  filesEnabled,
  error,
  onErrorChange,
  leftExtra,
  rightExtra,
  secondaryAction,
}: ComposerProps) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepthRef = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const canSubmit = !disabled && Boolean(value.trim() || files.length);
  // Object URLs for image thumbnails; revoked when the file set changes/unmounts.
  const previews = useMemo(() => files.map((f) => (isImage(f) ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);
  // Textarea height is grown imperatively as the user types (below); when a
  // caller clears `value` programmatically after submit, collapse it back.
  useEffect(() => {
    if (!value && textareaRef.current) textareaRef.current.style.height = "auto";
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
      className={`${COMPOSER_SHELL_CLASS} ${dragActive ? "border-fel bg-fel/10" : ""}`}
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
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-iron-950/90 px-4 text-center font-mono text-xs font-semibold text-fel-bright" role="status">
          {filesEnabled ? t("session.compose.dropFiles") : t("session.compose.filesDisabled")}
        </div>
      )}
      {error && <div className="px-2 pb-1 pt-0.5 font-mono text-xs text-blood">⚠ {error}</div>}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-1 pb-1.5 pt-1">
          {files.map((f, i) => (
            <span key={i} className="flex items-center gap-1.5 rounded-md border border-iron-700 bg-iron-950 py-1 pl-1.5 pr-2 font-mono text-xs text-bone-dim">
              {previews[i] ? (
                <button type="button" title={t("session.compose.preview")} onClick={() => onPreviewFile(previews[i]!)} className="block h-4 w-4 shrink-0 overflow-hidden rounded-sm">
                  <img src={previews[i]!} alt="" className="h-full w-full object-cover" />
                </button>
              ) : (
                <svg className="shrink-0 text-bone-faint" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                  <path d="M14 2v6h6" />
                </svg>
              )}
              <span className="max-w-[130px] truncate" title={f.name}>{chipName(f)}</span>
              <button className="shrink-0 text-bone-faint transition-colors hover:text-blood" onClick={() => onFilesChange(files.filter((_, j) => j !== i))} disabled={disabled}>
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
        className="composer-input max-h-40 min-h-8 w-full resize-none bg-transparent px-1 py-1 font-body text-sm leading-normal text-bone placeholder:text-bone-faint focus:outline-none"
        rows={1}
        autoFocus={autoFocus}
        value={value}
        placeholder={placeholder}
        disabled={disabled && !autoFocus}
        readOnly={disabled && Boolean(autoFocus)}
        onChange={(e) => {
          onChange(e.target.value);
          e.target.style.height = "auto";
          e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
        }}
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
          if (!pasted.length) return; // plain text → paste normally
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
            className={`${COMPOSER_ICON_ACTION_CLASS} text-bone-faint hover:text-fel-bright disabled:opacity-30`}
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
              className={`${secondaryAction.mobileIcon ? `${COMPOSER_ICON_ACTION_CLASS} sm:w-auto sm:px-3` : COMPOSER_TEXT_ACTION_CLASS} font-mono text-xs text-bone-dim hover:text-ember disabled:cursor-wait disabled:opacity-40`}
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
            className={`flex h-8 w-8 flex-none items-center justify-center rounded-lg transition-colors ${canSubmit ? "bg-fel text-fel-ink hover:bg-fel-bright" : "on-surface text-bone-faint"}`}
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
