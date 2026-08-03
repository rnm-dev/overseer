import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { StatusDot } from "../ui";

interface Props {
  online: boolean;
  controlConnected?: boolean;
  controlConnectedAt?: number | null;
}

export function formatChannelUptime(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function peonConnectionDotState({ online, controlConnected }: Props): "on" | "busy" {
  return (controlConnected ?? online) ? "on" : "busy";
}

export function PeonConnectionStatusDot(props: Props) {
  const t = useT();
  const tooltipId = useId();
  const showTimer = useRef<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [position, setPosition] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const control = props.controlConnected ?? props.online;
  const connected = t("socket.connected");
  const disconnected = t("socket.disconnected");
  const hasUptime = control && props.controlConnectedAt != null;

  useEffect(() => {
    if (!hasUptime || !position) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasUptime, position]);

  useEffect(() => () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
  }, []);

  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(null);
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [position]);

  const channelLabel = (name: string, active: boolean, startedAt: number | null | undefined) => {
    const status = active ? connected : disconnected;
    if (!active || startedAt == null) return `${name}: ${status}`;
    return `${name}: ${status} · ${t("socket.uptime", { duration: formatChannelUptime(now - startedAt) })}`;
  };
  const channels = [
    { name: t("socket.control"), active: control, startedAt: props.controlConnectedAt },
  ];
  const label = channels.map((channel) => channelLabel(channel.name, channel.active, channel.startedAt)).join("\n");

  const show = (element: HTMLElement) => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    showTimer.current = window.setTimeout(() => {
      showTimer.current = null;
      const rect = element.getBoundingClientRect();
      const halfWidth = Math.min(144, Math.max(96, window.innerWidth / 2 - 8));
      const above = rect.bottom > window.innerHeight - 104;
      setNow(Date.now());
      setPosition({
        left: Math.max(halfWidth, Math.min(window.innerWidth - halfWidth, rect.left + rect.width / 2)),
        top: above ? rect.top - 9 : rect.bottom + 9,
        above,
      });
    }, 120);
  };

  const hide = () => {
    if (showTimer.current !== null) window.clearTimeout(showTimer.current);
    showTimer.current = null;
    setPosition(null);
  };

  return (
    <span
      className="relative inline-flex cursor-help"
      aria-label={position ? undefined : label}
      aria-describedby={position ? tooltipId : undefined}
      onMouseEnter={(event) => show(event.currentTarget)}
      onMouseLeave={hide}
      onFocus={(event) => show(event.currentTarget)}
      onBlur={hide}
    >
      <StatusDot state={peonConnectionDotState(props)} />
      {position && createPortal(
        <span
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none fixed z-[100] w-64 rounded-lg border border-edge-strong/90 bg-surface/95 p-2.5 text-left shadow-[0_12px_32px_rgba(0,0,0,0.55),0_0_0_1px_rgba(149,201,103,0.05)] backdrop-blur-md"
          style={{
            left: position.left,
            top: position.top,
            transform: `translate(-50%, ${position.above ? "-100%" : "0"})`,
          }}
        >
          <span className="grid">
            {channels.map((channel, index) => {
              const uptime = channel.active && channel.startedAt != null
                ? t("socket.uptime", { duration: formatChannelUptime(now - channel.startedAt) })
                : null;
              return (
                <span key={channel.name} className={`flex items-center gap-2 px-1 py-1.5 ${index > 0 ? "border-t border-edge/80" : ""}`}>
                  <StatusDot state={channel.active ? "on" : "off"} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-display text-[0.72rem] font-semibold text-ink">{channel.name}</span>
                    {uptime && <span className="block font-mono text-[0.58rem] leading-tight text-ink-faint">{uptime}</span>}
                  </span>
                  <span className={`font-mono text-[0.58rem] uppercase tracking-[0.08em] ${channel.active ? "text-accent-strong" : "text-ink-faint"}`}>
                    {channel.active ? connected : disconnected}
                  </span>
                </span>
              );
            })}
          </span>
        </span>,
        document.body,
      )}
    </span>
  );
}
