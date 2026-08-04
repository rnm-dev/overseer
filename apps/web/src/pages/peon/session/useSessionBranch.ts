import { useCallback, useEffect, useState } from "react";
import type { NavigateFunction } from "react-router";
import { ApiError } from "../../../api";
import type { Translate } from "../../../i18n";
import { createSessionBranch } from "./sessionBranch";

export function sessionBranchHref(
  peonId: string,
  sessionId: string,
  href: ((peonId: string, sessionId: string) => string) | undefined,
): string {
  return href?.(peonId, sessionId) ?? `/peons/${encodeURIComponent(peonId)}/sessions/${encodeURIComponent(sessionId)}`;
}

export function sessionBranchError(error: unknown, t: Translate): string {
  return error instanceof ApiError ? error.message : t("session.branch.failed");
}

export async function createAndNavigateSessionBranch({
  base,
  sessionId,
  peonId,
  href,
  navigate,
  request = createSessionBranch,
}: {
  base: string;
  sessionId: string;
  peonId: string;
  href?: (peonId: string, sessionId: string) => string;
  navigate: (to: string) => void;
  request?: (base: string, sessionId: string) => Promise<{ id: string }>;
}): Promise<void> {
  const created = await request(base, sessionId);
  navigate(sessionBranchHref(peonId, created.id, href));
}

interface UseSessionBranchArgs {
  base: string;
  sessionId: string;
  sessionKey: string;
  peonId: string;
  sessionHref?: (peonId: string, sessionId: string) => string;
  navigate: NavigateFunction;
  disabled: boolean;
  t: Translate;
}

export function useSessionBranch({
  base,
  sessionId,
  sessionKey,
  peonId,
  sessionHref,
  navigate,
  disabled,
  t,
}: UseSessionBranchArgs) {
  const [branching, setBranching] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);

  useEffect(() => {
    setBranchError(null);
    setBranching(false);
  }, [sessionKey]);

  const branchSession = useCallback(async () => {
    if (branching || disabled) return;
    setBranching(true);
    setBranchError(null);
    try {
      await createAndNavigateSessionBranch({
        base,
        sessionId,
        peonId,
        href: sessionHref,
        navigate,
      });
    } catch (error) {
      setBranchError(sessionBranchError(error, t));
      setBranching(false);
    }
  }, [base, branching, disabled, navigate, peonId, sessionHref, sessionId, t]);

  return { branching, branchError, branchSession };
}
