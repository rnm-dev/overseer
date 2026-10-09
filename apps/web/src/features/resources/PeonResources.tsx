import { useEffect, useState } from "react";
import { useOutletContext } from "react-router";
import { useLiveSocket } from "../../realtime/liveSocket";
import type { ResourceUsageSample } from "../../realtime/resourceSubscriptions";
import type { PeonContext } from "../fleet/context";

const percent = (value: number) => `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
const bytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`;
};
function Meter({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <section className="rounded-xl border border-line bg-surface p-5">
    <div className="flex items-baseline justify-between gap-4"><h2 className="font-display text-base font-semibold text-ink">{label}</h2><strong className="font-mono text-xl text-ink">{percent(value)}</strong></div>
    <div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-hover"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: percent(value) }} /></div>
    <p className="mt-3 font-mono text-xs text-ink-muted">{detail}</p>
  </section>;
}

export function PeonResources() {
  const { peon } = useOutletContext<PeonContext>();
  const { subscribeResources } = useLiveSocket();
  const [sample, setSample] = useState<ResourceUsageSample | null>(null);
  useEffect(() => subscribeResources(peon.peonId, setSample), [peon.peonId, subscribeResources]);
  const hostMemory = sample ? (sample.host.memoryTotalBytes - sample.host.memoryFreeBytes) / sample.host.memoryTotalBytes * 100 : 0;
  return <main className="min-w-0 flex-1 overflow-y-auto p-5 md:p-8">
    <header><h1 className="font-display text-2xl font-bold text-ink">Resources</h1><p className="mt-1 font-mono text-sm text-ink-muted">Live resource usage from this Peon machine.</p></header>
    {!sample ? <div className="mt-8 rounded-xl border border-line bg-surface p-8 text-center font-mono text-sm text-ink-muted">Waiting for live resource data…</div> : <>
      <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Meter label="Host CPU" value={sample.host.cpuPercent} detail={`${sample.host.logicalCpuCount} logical CPUs · load ${sample.host.loadAverage.map((v) => v.toFixed(2)).join(" / ")}`} />
        <Meter label="Host memory" value={hostMemory} detail={`${bytes(sample.host.memoryTotalBytes - sample.host.memoryFreeBytes)} used of ${bytes(sample.host.memoryTotalBytes)}`} />
        <Meter label="Disk" value={sample.disk.usedPercent} detail={`${bytes(sample.disk.usedBytes)} used · ${bytes(sample.disk.availableBytes)} available`} />
        <Meter label="Peon CPU" value={Math.min(100, sample.process.cpuPercent / Math.max(1, sample.host.logicalCpuCount))} detail={`${sample.process.cpuPercent.toFixed(1)}% aggregate process CPU`} />
        <Meter label="Peon memory" value={sample.process.rssBytes / sample.host.memoryTotalBytes * 100} detail={`${bytes(sample.process.rssBytes)} RSS · ${bytes(sample.process.heapUsedBytes)} heap`} />
      </div>
      <p className="mt-5 font-mono text-xs text-ink-faint">Updated {new Date(sample.sampledAt).toLocaleTimeString()} · sample {sample.sequence}</p>
    </>}
  </main>;
}
