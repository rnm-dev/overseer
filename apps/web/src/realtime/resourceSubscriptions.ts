export interface ResourceUsageSample {
  version: string;
  sampledAt: number;
  sequence: number;
  process: { cpuPercent: number; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; uptimeSeconds: number };
  host: { cpuPercent: number; logicalCpuCount: number; loadAverage: number[]; memoryTotalBytes: number; memoryFreeBytes: number };
  disk: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
}
type Sender = (message: unknown) => void;
type Listener = (sample: ResourceUsageSample | null) => void;
interface Subscription {
  peonId: string;
  subscriptionId: string;
  listeners: Set<Listener>;
}

export class ResourceSubscriptions {
  private byPeon = new Map<string, Subscription>();
  private byId = new Map<string, Subscription>();
  private sender: Sender | null = null;
  private supported = false;

  connect(sender: Sender | null, supported = false): void {
    this.sender = sender;
    this.supported = supported;
    for (const sub of this.byPeon.values()) {
      if (sender && supported) this.start(sub);
      else this.notify(sub, null);
    }
  }

  subscribe = (peonId: string, listener: Listener): (() => void) => {
    let sub = this.byPeon.get(peonId);
    if (!sub) {
      sub = { peonId, subscriptionId: crypto.randomUUID(), listeners: new Set() };
      this.byPeon.set(peonId, sub);
      this.byId.set(sub.subscriptionId, sub);
    }
    const current = sub;
    current.listeners.add(listener);
    if (current.listeners.size === 1) this.start(current);
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size) return;
      this.byPeon.delete(peonId);
      this.byId.delete(current.subscriptionId);
      if (this.supported) this.sender?.({ type: "resources:unsubscribe", subscriptionId: current.subscriptionId });
    };
  };

  handle(message: Record<string, unknown>): void {
    const sub = typeof message.subscriptionId === "string" ? this.byId.get(message.subscriptionId) : undefined;
    if (!sub) return;
    if (message.type === "resources:sample" && message.sample && typeof message.sample === "object") {
      this.notify(sub, message.sample as unknown as ResourceUsageSample);
    } else if (message.type === "resources:error") {
      this.notify(sub, null);
    }
  }

  private start(sub: Subscription): void {
    if (!this.sender || !this.supported) {
      this.notify(sub, null);
      return;
    }
    this.sender({ type: "resources:subscribe", subscriptionId: sub.subscriptionId, peonId: sub.peonId });
  }

  private notify(sub: Subscription, sample: ResourceUsageSample | null): void {
    for (const listener of sub.listeners) listener(sample);
  }
}
