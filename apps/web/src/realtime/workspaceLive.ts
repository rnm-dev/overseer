import { useEffect, useState } from "react";
import { api } from "../shared/api";
import { createWorkspaceSocket } from "./workspaceSocket";
import type { PresenceEntry } from "./liveSocket";
import { useWorkspace } from "../features/workspaces/workspace";
import { parsePeonProjection, parsePeonProjections } from "../features/workspaces/workspacePeons";

// A normal Overseer workspace socket for fleet-dashboard sections that are not
// the selected workspace. It participates in the same hello/cursor/replay/live
// protocol; today the dashboard consumes presence, while future consumers can
// use the already-established event stream without another transport mode.
const FALLBACK_POLL_MS = 10_000;

export function useWorkspaceLivePresence(workspaceId: string, enabled: boolean): PresenceEntry[] {
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const { updatePeon } = useWorkspace();

  useEffect(() => {
    if (!enabled) {
      setPresence([]);
      return;
    }

    let stopped = false;
    let cursor = 0;

    const pullFallback = () => api<{ presence: PresenceEntry[] }>(`/workspaces/${workspaceId}/presence`)
      .then((result) => {
        if (!stopped) setPresence(result.presence ?? []);
      })
      .catch(() => undefined);

    // While the socket is down, poll presence over HTTP; an open socket stops it.
    let fallbackTimer: number | null = null;
    const stopFallback = () => {
      if (fallbackTimer !== null) window.clearInterval(fallbackTimer);
      fallbackTimer = null;
    };
    const startFallback = () => {
      void pullFallback();
      if (fallbackTimer === null) fallbackTimer = window.setInterval(() => void pullFallback(), FALLBACK_POLL_MS);
    };

    // Same clientId as the selected-workspace socket: these are extra sockets
    // of one tab, not another client competing for the notification sound.
    const transport = createWorkspaceSocket({
      workspaceId,
      getCursor: () => cursor,
      onOpen: stopFallback,
      onDisconnected: startFallback,
      onMessage: (message) => {
        if (message.type === "snapshot" || message.type === "presence") {
          setPresence((message.presence as PresenceEntry[]) ?? []);
          transport.resetBackoff();
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
          if (nextCursor > cursor) transport.requestResume();
        } else if (nextCursor > cursor) {
          cursor = nextCursor;
        }
      },
    });
    startFallback();

    return () => {
      stopped = true;
      stopFallback();
      transport.stop();
    };
  }, [enabled, updatePeon, workspaceId]);

  return presence;
}
