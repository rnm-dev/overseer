import { useOutletContext } from "react-router-dom";

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
  baseUrl: string;
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
  sessionHref?: (peonId: string, sessionId: string) => string;
  sessionsHomeHref?: string;
  onSessionDeleted?: (peonId: string, sessionId: string) => void;
}

export const usePeon = () => useOutletContext<PeonContext>();
