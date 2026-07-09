import { useOutletContext } from "react-router-dom";

// author: Viktor

// Registry view of a peon (server `toView` — never the raw token).
export interface PeonView {
  peonId: string;
  name: string | null;
  hostname: string | null;
  address: string;
  controlPort: number;
  connectionPinned: boolean;
  baseUrl: string;
  online: boolean;
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
}

export const usePeon = () => useOutletContext<PeonContext>();
