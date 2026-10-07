export const PROJECT_FILE_POLL_INTERVAL_MS = 2_000;

// Directory metadata has no push stream. Poll only while the tree is mounted
// and its page is visible; focus/reconnect revalidates without waiting a tick.
export function startProjectFilePolling(
  refresh: () => Promise<void>,
  page: EventTarget & { visibilityState: string } = document,
  browser: EventTarget = window,
): () => void {
  let stopped = false;
  let running = false;
  let queued = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clear();
    if (!stopped && page.visibilityState !== "hidden") {
      timer = setTimeout(() => void poll(), PROJECT_FILE_POLL_INTERVAL_MS);
    }
  };
  const poll = async () => {
    if (stopped || page.visibilityState === "hidden") return;
    if (running) { queued = true; return; }
    clear();
    running = true;
    try {
      await refresh();
    } catch {
      // Retain the last usable tree during a network interruption.
    } finally {
      running = false;
      if (!stopped && queued) {
        queued = false;
        void poll();
      } else schedule();
    }
  };
  const wake = () => { void poll(); };
  const visibility = () => {
    if (page.visibilityState === "hidden") { clear(); queued = false; }
    else wake();
  };

  page.addEventListener("visibilitychange", visibility);
  browser.addEventListener("focus", wake);
  browser.addEventListener("online", wake);
  schedule();
  return () => {
    stopped = true;
    clear();
    page.removeEventListener("visibilitychange", visibility);
    browser.removeEventListener("focus", wake);
    browser.removeEventListener("online", wake);
  };
}
