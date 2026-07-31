import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { PresenceUser } from "../liveSocket";
import { Avatar } from "./Avatar";

const MAX_VISIBLE = 3;

export function SessionPresence({ viewers, size = "sm" }: { viewers: PresenceUser[]; size?: "xs" | "sm" }) {
  if (viewers.length === 0) return null;
  const visible = viewers.slice(0, MAX_VISIBLE);

  return (
    <div className="flex flex-none -space-x-1.5" aria-label={viewers.map(displayName).join(", ")}>
      {visible.map((viewer) => (
        <PresenceTooltip key={viewer.userId} text={displayName(viewer)}>
          <Avatar src={viewer.avatarUrl} label={displayName(viewer)} tooltip={null} size={size} decorative className="border-edge-subtle ring-1 ring-accent/50" />
        </PresenceTooltip>
      ))}
      {viewers.length > MAX_VISIBLE && (
        <PresenceTooltip text={viewers.slice(MAX_VISIBLE).map(displayName).join("\n")}>
          <span className={`${size === "xs" ? "h-4 w-4 text-[0.48rem]" : "h-5 w-5 text-[0.55rem]"} grid place-items-center rounded-full border border-edge-subtle bg-surface-hover font-mono text-ink-muted ring-1 ring-accent/50`}>
            +{viewers.length - MAX_VISIBLE}
          </span>
        </PresenceTooltip>
      )}
    </div>
  );
}

function PresenceTooltip({ text, children }: { text: string; children: ReactNode }) {
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);

  return (
    <span
      className="relative inline-grid flex-none hover:z-50"
      onMouseEnter={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const halfMaxWidth = Math.min(120, window.innerWidth / 2);
        const above = rect.bottom > window.innerHeight - 48;
        setPosition({
          left: Math.max(halfMaxWidth, Math.min(window.innerWidth - halfMaxWidth, rect.left + rect.width / 2)),
          top: above ? rect.top - 6 : rect.bottom + 6,
          above,
        });
      }}
      onMouseLeave={() => setPosition(null)}
    >
      {children}
      {position && createPortal(
        <span
          role="tooltip"
          className="pointer-events-none fixed z-[100] w-max max-w-56 -translate-x-1/2 whitespace-pre-line rounded border border-edge-strong bg-surface px-2 py-1.5 text-left font-mono text-[0.65rem] font-normal leading-relaxed text-ink shadow-lg"
          style={{
            left: position.left,
            top: position.top,
            transform: `translate(-50%, ${position.above ? "-100%" : "0"})`,
          }}
        >
          {text}
        </span>,
        document.body,
      )}
    </span>
  );
}

function displayName(user: PresenceUser): string {
  return user.githubLogin || user.email;
}
