import { useOutletContext } from "react-router";
import type { PresenceUser } from "../../liveSocket";
import type { SessionLite } from "./sessionList";
import type { ProjectLite } from "./projectList";

// author: Viktor

// Registry view of a peon (server `toView` — never the raw token).
export interface PeonView {
  peonId: string;
  name: string | null;
  hostname: string | null;
  address: string;
  controlPort: number;
  publicUrl: string | null;
  addressSource: "paired" | "manual" | "advertised" | "discovered";
  connectionPinned: boolean;
  baseUrl: string | null;
  online: boolean;
  controlConnected?: boolean;
  transferConnected?: boolean;
  controlConnectedAt?: number | null;
  transferConnectedAt?: number | null;
  protocol: number | null;
  capabilities: string[];
  registeredAt: number;
  lastSeen: number;
  load: { activeSessions?: number; paused?: boolean; uptimeSec?: number } | null;
}

export interface PeonContext {
  peon: PeonView;
  wsId: string;
  base: string; // `/workspaces/${wsId}/peons/${peonId}`
  reload: () => void;
  isOwner: boolean;
  orderedSessionIds: string[];
  sessions?: SessionLite[];
  projects?: ProjectLite[];
  sessionsLoading?: boolean;
  sessionPageError?: boolean;
  viewersFor?: (peonId: string, sessionId: string) => PresenceUser[];
  renameSession?: (session: SessionLite, title: string | null) => Promise<void>;
  deleteSession?: (session: SessionLite) => Promise<void>;
  // The indexed row for the session currently open, so its page can name it
  // without waiting for the session record.
  selectedSession?: SessionLite;
  sessionHref?: (peonId: string, sessionId: string) => string;
  sessionsHomeHref?: string;
  onSessionDeleted?: (peonId: string, sessionId: string) => void;
  onSessionRunningChange?: (peonId: string, sessionId: string, running: boolean, changedAt: number) => void;
}

export const usePeon = () => useOutletContext<PeonContext>();
