import { useEffect, useState } from "react";
import { api } from "../shared/api";
import { audioClientId } from "./audioFocus";
import type { PresenceEntry } from "./liveSocket";
import { useWorkspace } from "../features/workspaces/workspace";
import { parsePeonProjection, parsePeonProjections } from "../features/workspaces/workspacePeons";

// A normal Overseer workspace socket for fleet-dashboard sections that are not
// the selected workspace. It participates in the same hello/cursor/replay/live
// protocol; today the dashboard consumes presence, while future consumers can
// use the already-established event stream without another transport mode.
export function useWorkspaceLivePresence(workspaceId: string, enabled: boolean): PresenceEntry[] {
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const { updatePeon } = useWorkspace();

  useEffect(() => {
    if (!enabled) {
      setPresence([]);
      return;
    }

    let stopped = false;
    let socket: WebSocket | null = null;
    let retry: number | null = null;
    let backoff = 1_000;
    let cursor = 0;
    let lastReceivedAt = Date.now();

    const pullFallback = () => api<{ presence: PresenceEntry[] }>(`/workspaces/${workspaceId}/presence`)
      .then((result) => {
        if (!stopped) setPresence(result.presence ?? []);
      })
      .catch(() => undefined);

    const schedule = () => {
      if (stopped || retry !== null) return;
      retry = window.setTimeout(() => {
        retry = null;
        void connect();
      }, Math.round(backoff * (0.8 + Math.random() * 0.4)));
      backoff = Math.min(backoff * 2, 10_000);
    };

    const connect = async () => {
      if (stopped || socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
      let ticket: string;
      try {
        ({ ticket } = await api<{ ticket: string }>("/auth/ws-ticket", { method: "POST" }));
      } catch {
        schedule();
        return;
      }
      if (stopped) return;
      const ws = new WebSocket(`${location.origin.replace(/^http/, "ws")}/api/ws?ticket=${encodeURIComponent(ticket)}`);
      socket = ws;
      ws.onopen = () => {
        lastReceivedAt = Date.now();
        // Same clientId as the selected-workspace socket: these are extra sockets
        // of one tab, not another client competing for the notification sound.
        ws.send(JSON.stringify({ type: "hello", workspaceId, cursor, clientId: audioClientId() }));
      };
      ws.onmessage = (event) => {
        lastReceivedAt = Date.now();
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "snapshot" || message.type === "presence") {
          setPresence((message.presence as PresenceEntry[]) ?? []);
          backoff = 1_000;
        }
        if (message.type === "snapshot") {
          for (const peon of parsePeonProjections(message.peonPresence)) updatePeon(workspaceId, peon);
        }
        if (message.type === "peon") {
          const peon = parsePeonProjection(message.payload);
          if (peon) updatePeon(workspaceId, peon);
        }
        const nextCursor = Number(message.cursor) || 0;
        if (message.type === "sync") {
          if (nextCursor > cursor && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resume", cursor }));
        } else if (nextCursor > cursor) {
          cursor = nextCursor;
        }
      };
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (socket === ws) socket = null;
        schedule();
      };
    };

    void pullFallback();
    void connect();
    const heartbeat = window.setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN && Date.now() - lastReceivedAt > 25_000) {
        socket.close();
        void pullFallback();
      } else if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
      else {
        void pullFallback();
        void connect();
      }
    }, 10_000);
    const wake = () => {
      void pullFallback();
      if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) void connect();
    };
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);

    return () => {
      stopped = true;
      window.clearInterval(heartbeat);
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      if (retry !== null) window.clearTimeout(retry);
      socket?.close(1000);
    };
  }, [enabled, updatePeon, workspaceId]);

  return presence;
}
