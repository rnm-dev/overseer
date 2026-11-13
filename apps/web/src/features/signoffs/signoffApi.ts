import { useCallback, useEffect, useState } from "react";
import { api } from "../../shared/api";

// Session sign-offs (docs/signoffs.md). Peon owns the records; Overseer lists
// them across the workspace's online Peons and forwards decisions.

export type SignoffStatus =
  | "pending" | "changes_requested" | "approved" | "executing" | "done" | "partly_done"
  | "failed" | "rejected" | "withdrawn" | "superseded" | "interrupted";

export interface SignoffSummary {
  id: string;
  peonId: string;
  peonName: string;
  projectKey: string | null;
  displayNumber: string;
  title: string;
  sessionId: string;
  headSeq: number;
  status: SignoffStatus;
  assigneeIds: string[];
  orphaned: boolean;
  createdAt: number;
  updatedAt: number;
  canDecide: boolean;
  awaitingViewer: boolean;
}

export interface SignoffAction { id: string; summary: string; detail?: string }
export interface SignoffOption { id: string; label: string; recommended?: boolean; rationale?: string; actions: SignoffAction[] }
export interface SignoffSnapshot { title: string; summary: string; options: SignoffOption[]; assignees: string[]; context: string[] }
export interface SignoffEvent {
  seq: number;
  author: { type: "agent"; sessionId: string } | { type: "operator"; id: string } | { type: "policy" } | { type: "peon" };
  kind: string;
  baseSeq: number | null;
  message?: string;
  optionId?: string;
  results?: { actionId: string; outcome: string; note?: string }[];
  createdAt: number;
}
export interface SignoffView { signoff: SignoffSummary; snapshot: SignoffSnapshot; events: SignoffEvent[] }

export interface UnavailablePeon { peonId: string; peonName: string; reason: "offline" | "unsupported" | "error" }

export const signoffPath = (wsId: string, peonId: string, signoffId: string) =>
  `/workspaces/${encodeURIComponent(wsId)}/peons/${encodeURIComponent(peonId)}/signoffs/${encodeURIComponent(signoffId)}`;

const POLL_MS = 20_000;

/** Workspace sign-offs, refreshed on an interval and on demand. */
export function useWorkspaceSignoffs(wsId: string | undefined, scope: "open" | "all") {
  const [signoffs, setSignoffs] = useState<SignoffSummary[] | null>(null);
  const [unavailable, setUnavailable] = useState<UnavailablePeon[]>([]);
  const [error, setError] = useState(false);
  const reload = useCallback(async () => {
    if (!wsId) return;
    try {
      const body = await api<{ signoffs: SignoffSummary[]; unavailable: UnavailablePeon[] }>(
        `/workspaces/${encodeURIComponent(wsId)}/signoffs?scope=${scope}`,
      );
      setSignoffs(body.signoffs);
      setUnavailable(body.unavailable);
      setError(false);
    } catch {
      setError(true);
    }
  }, [scope, wsId]);
  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => void reload(), POLL_MS);
    const onChange = () => void reload();
    window.addEventListener("overseer:signoffs-changed", onChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("overseer:signoffs-changed", onChange);
    };
  }, [reload]);
  return { signoffs, unavailable, error, reload };
}

export function notifySignoffsChanged(): void {
  window.dispatchEvent(new Event("overseer:signoffs-changed"));
}

export const OPEN: ReadonlySet<SignoffStatus> = new Set(["pending", "changes_requested", "approved", "executing"]);
