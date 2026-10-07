export interface ProjectFileWatchTarget { peonId: string; projectKey: string; path: string }
export type ProjectFileWatchStatus = "ready" | "changed" | "unavailable";
type Sender = (message: unknown) => void;
interface Subscription {
  target: ProjectFileWatchTarget;
  watchId: string;
  listeners: Set<(status: ProjectFileWatchStatus) => void>;
  retry?: ReturnType<typeof setTimeout>;
  backoff: number;
  status?: ProjectFileWatchStatus;
}

// Multiplex over the existing workspace socket. Timers retry failed watches;
// healthy watches never poll. Every ready frame causes a fresh directory read.
export class ProjectFileSubscriptions {
  private subscriptions = new Map<string, Subscription>();
  private sender: Sender | null = null;
  private supported = false;
  connect(sender: Sender | null, supported = false): void {
    this.sender = sender;
    this.supported = supported;
    for (const sub of this.subscriptions.values()) {
      clearTimeout(sub.retry);
      sub.retry = undefined;
      sub.status = undefined;
      if (sender) this.start(sub);
      else this.notify(sub, "unavailable");
    }
  }
  subscribe = (target: ProjectFileWatchTarget, listener: (status: ProjectFileWatchStatus) => void): (() => void) => {
    const key = JSON.stringify([target.peonId, target.projectKey, target.path]);
    let sub = this.subscriptions.get(key);
    if (!sub) {
      sub = { target, watchId: crypto.randomUUID(), listeners: new Set(), backoff: 1000 };
      this.subscriptions.set(key, sub);
    }
    const current = sub;
    current.listeners.add(listener);
    if (current.listeners.size === 1) this.start(current);
    else if (current.status) listener(current.status === "changed" ? "ready" : current.status);
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size) return;
      clearTimeout(current.retry);
      this.subscriptions.delete(key);
      if (this.supported) this.sender?.({ type: "files:unsubscribe", watchId: current.watchId });
    };
  };
  handle(message: Record<string, unknown>): void {
    const sub = [...this.subscriptions.values()].find((value) => value.watchId === message.watchId);
    if (!sub) return;
    if (message.type === "files:ready" || message.type === "files:changed") {
      // Keep exponential pressure after repeated ready-then-fail cycles, reset
      // only once useful change traffic has arrived.
      if (message.type === "files:changed") sub.backoff = 1000;
      this.notify(sub, message.type === "files:ready" ? "ready" : "changed");
    } else if (message.type === "files:error") {
      this.notify(sub, "unavailable");
      if (message.retryable === true && this.sender && !sub.retry) {
        sub.retry = setTimeout(() => {
          sub.retry = undefined;
          this.start(sub);
        }, sub.backoff);
        sub.backoff = Math.min(30_000, sub.backoff * 2);
      }
    }
  }
  private start(sub: Subscription): void {
    if (!this.sender) return;
    if (!this.supported) { this.notify(sub, "unavailable"); return; }
    this.sender({ type: "files:subscribe", watchId: sub.watchId, ...sub.target });
  }
  private notify(sub: Subscription, status: ProjectFileWatchStatus): void {
    sub.status = status;
    for (const listener of sub.listeners) listener(status);
  }
}
