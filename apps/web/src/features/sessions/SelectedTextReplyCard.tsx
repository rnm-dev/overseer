import { CornerUpLeft, X } from "lucide-react";
import type { SelectedTextReply } from "./selectedTextReply";
import { replyPreview } from "./selectedTextReply";

export function SelectedTextReplyCard({
  replyTo,
  onClear,
  onOpenSource,
  compact = false,
}: {
  replyTo: SelectedTextReply;
  onClear?: () => void;
  onOpenSource?: () => void;
  compact?: boolean;
}) {
  const content = (
    <>
      <CornerUpLeft size={compact ? 12 : 14} className="mt-0.5 shrink-0 text-accent-strong" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="block font-mono text-[0.625rem] uppercase tracking-[0.08em] text-ink-faint">Selected text</span>
        <span className={`mt-0.5 block whitespace-pre-wrap break-words text-ink-muted ${compact ? "line-clamp-2 text-[0.6875rem]" : "line-clamp-3 text-xs"}`}>
          {replyPreview(replyTo.selectedText)}
        </span>
      </span>
      {onClear && (
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded text-ink-faint hover:bg-surface-active hover:text-danger"
          aria-label="Clear selected-text reply"
          title="Clear selected-text reply"
          onClick={(event) => { event.stopPropagation(); onClear(); }}
        >
          <X size={13} aria-hidden />
        </button>
      )}
    </>
  );
  const className = `flex min-w-0 items-start gap-2 rounded-lg border border-accent/25 bg-accent/5 ${compact ? "px-2 py-1.5" : "px-2.5 py-2"}`;
  if (!onOpenSource) return <div className={className}>{content}</div>;
  return (
    <div role="button" tabIndex={0} className={`${className} w-full text-left transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60`} onClick={onOpenSource} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenSource(); } }} title="Open source message">
      {content}
    </div>
  );
}
