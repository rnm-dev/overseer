import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Copy, CornerUpLeft, ExternalLink, Link2 } from "lucide-react";
import { replyPreview, selectedTextReplyForRow, type SelectedTextReply } from "./selectedTextReply";

export interface SelectionSnapshot {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
}

export function captureSelectionSnapshot(selection: Selection): SelectionSnapshot {
  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  };
}

export function selectionSnapshotMatches(selection: Selection | null, snapshot: SelectionSnapshot): boolean {
  return !!selection &&
    selection.anchorNode === snapshot.anchorNode &&
    selection.anchorOffset === snapshot.anchorOffset &&
    selection.focusNode === snapshot.focusNode &&
    selection.focusOffset === snapshot.focusOffset;
}

export function selectedTextReplyContextMenuLabels(linkHref?: string | null): string[] {
  return ["Reply", "Copy", ...(linkHref ? ["Open link in new tab", "Copy link address"] : [])];
}

export function activateSelectedTextReply(replyTo: SelectedTextReply, onReply: (replyTo: SelectedTextReply) => void): void {
  onReply(replyTo);
}

export function contextMenuPosition(
  x: number,
  y: number,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth: number,
  menuHeight: number,
  margin = 8,
): { x: number; y: number } {
  return {
    x: Math.max(margin, Math.min(x, viewportWidth - menuWidth - margin)),
    y: Math.max(margin, Math.min(y, viewportHeight - menuHeight - margin)),
  };
}

/** Copy without disturbing the active transcript selection when the browser
 * exposes the asynchronous Clipboard API. The fallback restores the
 * selection after using a temporary textarea for older browser contexts. */
export async function copySelectedText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the synchronous browser-era copy path.
  }

  const selection = document.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  let copied: boolean;
  try {
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  }
  textarea.remove();
  if (selection) {
    selection.removeAllRanges();
    for (const range of ranges) selection.addRange(range);
  }
  return copied;
}

interface Props {
  replyTo: SelectedTextReply;
  row: HTMLElement;
  selection: SelectionSnapshot;
  x: number;
  y: number;
  linkHref?: string | null;
  onReply: (replyTo: SelectedTextReply) => void;
  onClose: () => void;
}

const MENU_WIDTH = 232;
const MENU_MARGIN = 8;

export function SelectedTextReplyContextMenu({ replyTo, row, selection, x, y, linkHref, onReply, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState(() => (
    typeof window === "undefined"
      ? { x, y }
      : contextMenuPosition(x, y, window.innerWidth, window.innerHeight, MENU_WIDTH, 180, MENU_MARGIN)
  ));

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition(contextMenuPosition(x, y, window.innerWidth, window.innerHeight, bounds.width, bounds.height, MENU_MARGIN));
  }, [linkHref, x, y]);

  useEffect(() => {
    itemRefs.current[0]?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    const closeOnSelectionChange = () => {
      const currentSelection = window.getSelection();
      const currentReply = selectedTextReplyForRow(row, replyTo.eventId, currentSelection);
      if (!currentReply || currentReply.selectedText !== replyTo.selectedText || !selectionSnapshotMatches(currentSelection, selection)) {
        onClose();
      }
    };
    const closeOnViewportChange = () => onClose();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("selectionchange", closeOnSelectionChange);
    window.addEventListener("scroll", closeOnViewportChange, true);
    window.addEventListener("resize", closeOnViewportChange);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("selectionchange", closeOnSelectionChange);
      window.removeEventListener("scroll", closeOnViewportChange, true);
      window.removeEventListener("resize", closeOnViewportChange);
    };
  }, [onClose, replyTo.eventId, replyTo.selectedText, row, selection]);

  const focusItem = (index: number) => {
    const count = itemRefs.current.length;
    if (!count) return;
    itemRefs.current[(index + count) % count]?.focus();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusItem(currentIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusItem(currentIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusItem(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusItem(itemRefs.current.length - 1);
    } else if (event.key === "Tab") {
      onClose();
    }
  };

  const runCopy = (text: string) => {
    onClose();
    void copySelectedText(text);
  };

  const activateReply = () => {
    onClose();
    activateSelectedTextReply(replyTo, onReply);
  };

  const openLink = () => {
    if (!linkHref) return;
    onClose();
    window.open(linkHref, "_blank", "noopener,noreferrer");
  };

  if (typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Text selection actions"
      data-selected-text-reply-menu
      className="fixed z-[120] w-[14.5rem] overflow-hidden rounded-xl border border-edge-strong bg-surface/95 py-1 shadow-2xl backdrop-blur"
      style={{ left: position.x, top: position.y }}
      onKeyDown={handleMenuKeyDown}
    >
      <div className="border-b border-edge/70 px-3 py-2" role="group" aria-label="Selected text preview">
        <div className="font-mono text-[0.625rem] uppercase tracking-[0.08em] text-ink-faint">Selected text</div>
        <div className="mt-1 line-clamp-2 whitespace-pre-wrap break-words font-body text-xs text-ink-muted">{replyPreview(replyTo.selectedText, 120)}</div>
      </div>
      <button
        type="button"
        role="menuitem"
        ref={(node) => { itemRefs.current[0] = node; }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-body text-xs text-accent-strong transition-colors hover:bg-accent/10 hover:text-ink focus-visible:bg-accent/10 focus-visible:outline-none"
        onClick={activateReply}
      >
        <CornerUpLeft size={14} aria-hidden />
        <span>Reply</span>
      </button>
      <button
        type="button"
        role="menuitem"
        ref={(node) => { itemRefs.current[1] = node; }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left font-body text-xs text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:bg-surface-hover focus-visible:outline-none"
        onClick={() => runCopy(replyTo.selectedText)}
      >
        <Copy size={14} aria-hidden />
        <span>Copy</span>
      </button>
      {linkHref && (
        <>
          <div role="separator" className="my-1 border-t border-edge/60" />
          <button
            type="button"
            role="menuitem"
            ref={(node) => { itemRefs.current[2] = node; }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-body text-xs text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:bg-surface-hover focus-visible:outline-none"
            onClick={openLink}
          >
            <ExternalLink size={14} aria-hidden />
            <span>Open link in new tab</span>
          </button>
          <button
            type="button"
            role="menuitem"
            ref={(node) => { itemRefs.current[3] = node; }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left font-body text-xs text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:bg-surface-hover focus-visible:outline-none"
            onClick={() => runCopy(linkHref)}
          >
            <Link2 size={14} aria-hidden />
            <span>Copy link address</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  );
}
