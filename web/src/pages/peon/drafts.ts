import { useCallback, useEffect, useState } from "react";

const DRAFT_PREFIX = "overseer:composer-draft";

function readDraft(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Draft persistence is best-effort when storage is disabled or full.
  }
}

export function composerDraftKey(workspaceId: string, peonId: string, sessionId: string | null): string {
  const scope = sessionId || "new-session";
  return [DRAFT_PREFIX, workspaceId, peonId, scope].map(encodeURIComponent).join(":");
}

export function useComposerDraft(key: string, initialValue?: string, persist = true): [string, (value: string) => void] {
  const [draft, setDraft] = useState(() => ({ key, value: initialValue ?? readDraft(key) }));

  // React Router can reuse the session detail component when only :sid changes.
  // Load the new session's draft instead of carrying the previous input across.
  useEffect(() => {
    if (draft.key !== key) setDraft({ key, value: readDraft(key) });
  }, [draft.key, key]);

  const setValue = useCallback((value: string) => {
    if (persist) writeDraft(key, value);
    setDraft({ key, value });
  }, [key, persist]);

  // Avoid rendering the previous session's text during the route-change render.
  return [draft.key === key ? draft.value : readDraft(key), setValue];
}
