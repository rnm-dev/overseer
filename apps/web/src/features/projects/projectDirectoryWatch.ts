import { useEffect, useRef, useState, type RefObject } from "react";
import { useLiveSocket } from "../../realtime/liveSocket";

export function visibleDirectories(expanded: ReadonlySet<string>): string[] {
  return [...expanded].filter((directory) => {
    const parts = directory.split("/");
    for (let i = 1; i < parts.length; i++) if (!expanded.has(parts.slice(0, i).join("/"))) return false;
    return true;
  }).sort();
}

// Keep one trailing read if an invalidation arrives while a listing is in
// flight. Request deduplication alone would reuse the old pre-event response.
export function directoryInvalidator(refresh: () => Promise<void | boolean>): { changed: () => void; close: () => void } {
  let running = false;
  let dirty = false;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1000;
  const changed = () => {
    clearTimeout(retry);
    retry = undefined;
    dirty = true;
    if (running || closed) return;
    running = true;
    void (async () => {
      while (dirty && !closed) {
        dirty = false;
        let success = false;
        try { success = (await refresh()) !== false; } catch { /* retain the last usable listing */ }
        if (!success && !closed) {
          retry = setTimeout(changed, backoff);
          backoff = Math.min(30_000, backoff * 2);
          return;
        }
        backoff = 1000;
      }
    })().finally(() => {
      running = false;
      if (dirty && !closed && !retry) changed();
    });
  };
  return {
    changed,
    close: () => { closed = true; clearTimeout(retry); },
  };
}

export function useProjectDirectoryWatch(
  peonId: string, projectKey: string, expanded: ReadonlySet<string>,
  refresh: (directory: string) => Promise<void | boolean>, element: RefObject<HTMLDivElement | null>,
): boolean {
  const { subscribeFiles } = useLiveSocket();
  const [visible, setVisible] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const refreshRef = useRef(refresh);
  useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  const directories = JSON.stringify(visibleDirectories(expanded));
  const subscriptions = useRef(new Map<string, { stop: () => void; failed: boolean; changed: () => void }>());

  useEffect(() => {
    const node = element.current;
    const sync = () => setVisible(document.visibilityState !== "hidden" && !!node?.getClientRects().length);
    const observer = new ResizeObserver(sync);
    if (node) observer.observe(node);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("resize", sync);
    sync();
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("resize", sync);
    };
  }, [element]);

  useEffect(() => {
    const active = subscriptions.current;
    const reconcile = () => {
      for (const sub of active.values()) sub.changed();
    };
    window.addEventListener("focus", reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      window.removeEventListener("focus", reconcile);
      window.removeEventListener("online", reconcile);
      for (const sub of active.values()) sub.stop();
      active.clear();
    };
  }, [peonId, projectKey]);

  useEffect(() => {
    const active = subscriptions.current;
    const desired = new Set<string>(visible ? JSON.parse(directories) as string[] : []);
    for (const [path, sub] of active) {
      if (!desired.has(path)) { sub.stop(); active.delete(path); }
    }
    for (const path of desired) {
      if (active.has(path)) continue;
      const invalidator = directoryInvalidator(() => refreshRef.current(path));
      const sub = { failed: false, changed: invalidator.changed, stop: () => {} };
      active.set(path, sub);
      const unsubscribe = subscribeFiles({ peonId, projectKey, path }, (status) => {
        sub.failed = status === "unavailable";
        setUnavailable([...active.values()].some((value) => value.failed));
        if (!sub.failed) invalidator.changed();
      });
      sub.stop = () => { invalidator.close(); unsubscribe(); };
    }
    setUnavailable([...active.values()].some((value) => value.failed));
  }, [peonId, projectKey, directories, visible, subscribeFiles]);
  return unavailable;
}
