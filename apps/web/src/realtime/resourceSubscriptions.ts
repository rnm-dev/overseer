export interface ResourceUsageSample {
  version: string; sampledAt: number; sequence: number;
  process: { cpuPercent: number; rssBytes: number; heapUsedBytes: number; heapTotalBytes: number; uptimeSeconds: number };
  host: { cpuPercent: number; logicalCpuCount: number; loadAverage: number[]; memoryTotalBytes: number; memoryFreeBytes: number };
  disk: { totalBytes: number; usedBytes: number; availableBytes: number; usedPercent: number };
}
type Sender = (message: unknown) => void;
interface Subscription { peonId: string; subscriptionId: string; listeners: Set<(sample: ResourceUsageSample | null) => void> }

export class ResourceSubscriptions {
  private subscriptions = new Map<string, Subscription>(); private sender: Sender | null = null; private supported = false;
  connect(sender: Sender | null, supported = false): void {
    this.sender = sender; this.supported = supported;
    for (const sub of this.subscriptions.values()) { if (sender && supported) this.start(sub); else this.notify(sub, null); }
  }
  subscribe = (peonId: string, listener: (sample: ResourceUsageSample | null) => void): (() => void) => {
    let sub = this.subscriptions.get(peonId);
    if (!sub) { sub = { peonId, subscriptionId: crypto.randomUUID(), listeners: new Set() }; this.subscriptions.set(peonId, sub); }
    sub.listeners.add(listener); if (sub.listeners.size === 1) this.start(sub);
    return () => { sub!.listeners.delete(listener); if (sub!.listeners.size) return; this.subscriptions.delete(peonId); if (this.supported) this.sender?.({ type: "resources:unsubscribe", subscriptionId: sub!.subscriptionId }); };
  };
  handle(message: Record<string, unknown>): void {
    const sub = [...this.subscriptions.values()].find((entry) => entry.subscriptionId === message.subscriptionId); if (!sub) return;
    if (message.type === "resources:sample" && message.sample && typeof message.sample === "object") this.notify(sub, message.sample as unknown as ResourceUsageSample);
    else if (message.type === "resources:error") this.notify(sub, null);
  }
  private start(sub: Subscription): void { if (!this.sender || !this.supported) { this.notify(sub, null); return; } this.sender({ type: "resources:subscribe", subscriptionId: sub.subscriptionId, peonId: sub.peonId }); }
  private notify(sub: Subscription, sample: ResourceUsageSample | null): void { for (const listener of sub.listeners) listener(sample); }
}
