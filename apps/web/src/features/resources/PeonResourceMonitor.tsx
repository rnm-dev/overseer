import { useEffect, useMemo, useState } from "react";
import { Activity, Cpu, Database, MemoryStick } from "lucide-react";
import { useLiveSocket } from "../../realtime/liveSocket";
import type { ResourceUsageSample } from "../../realtime/resourceSubscriptions";
import { Card } from "../../shared/ui";

const MAX_SAMPLES = 300;
const bytes = (value: number) => { const units = ["B", "KB", "MB", "GB", "TB"]; let amount = value; let unit = 0; while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; } return `${amount.toFixed(unit < 2 ? 0 : 1)} ${units[unit]}`; };
const pct = (value: number) => `${Math.max(0, Math.min(100, value)).toFixed(1)}%`;
const memoryPercent = (sample: ResourceUsageSample) => (sample.host.memoryTotalBytes - sample.host.memoryFreeBytes) / sample.host.memoryTotalBytes * 100;
const peonCpuPercent = (sample: ResourceUsageSample) => Math.min(100, sample.process.cpuPercent / Math.max(1, sample.host.logicalCpuCount));
function points(values: number[], range: [number, number], width = 600, height = 76): string {
  const step = width / (MAX_SAMPLES - 1);
  const start = width - step * Math.max(0, values.length - 1);
  const span = Math.max(1, range[1] - range[0]);
  return values.map((value, index) => `${start + index * step},${height - (Math.max(range[0], Math.min(range[1], value)) - range[0]) / span * height}`).join(" ");
}

function LiveChart({ title, icon: Icon, primary, primaryValue, secondary, secondaryValue, detail }: { title: string; icon: typeof Activity; primary: number[]; primaryValue: number; secondary?: number[]; secondaryValue?: number; detail: string }) {
  const range: [number, number] = [0, 100];
  const area = points(primary, range);
  const areaStart = 600 - 600 / (MAX_SAMPLES - 1) * Math.max(0, primary.length - 1);
  return <Card className="overflow-hidden p-0">
    <div className="flex items-start justify-between gap-4 px-5 pt-5"><div><div className="flex items-center gap-2 text-ink-muted"><Icon size={15} aria-hidden /><h3 className="font-display text-sm font-bold text-ink">{title}</h3></div><p className="mt-1.5 font-mono text-[11px] text-ink-faint">{detail}</p></div><strong className="font-mono text-xl font-semibold tabular-nums text-ink">{pct(primaryValue)}</strong></div>
    <div className="relative mx-5 mb-4 mt-4 h-20 overflow-hidden rounded-lg bg-ink/[0.025]">
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 600 76" preserveAspectRatio="none" role="img" aria-label={`${title} recent history`}>
        <g className="text-ink-faint" opacity="0.12" stroke="currentColor" strokeWidth="0.6" vectorEffect="non-scaling-stroke">
          <path d="M150 0V76 M300 0V76 M450 0V76" />
          <path d="M0 19H600 M0 38H600 M0 57H600" />
        </g>
        {area && <><polygon points={`${areaStart},76 ${area} 600,76`} className="fill-accent/8" /><polyline points={area} className="fill-none stroke-accent/80" strokeWidth="1.25" vectorEffect="non-scaling-stroke" /></>}
        {secondary && <polyline points={points(secondary, range)} className="fill-none stroke-ink-faint/70" strokeWidth="1" strokeDasharray="4 5" vectorEffect="non-scaling-stroke" />}
      </svg>
      {secondary && <span className="absolute bottom-2 left-3 rounded-md bg-canvas/70 px-2 py-1 font-mono text-[9px] text-ink-faint backdrop-blur">Daemon {pct(secondaryValue ?? 0)}</span>}
    </div>
  </Card>;
}

export function PeonResourceMonitor({ peonId }: { peonId: string }) {
  const { subscribeResources } = useLiveSocket();
  const [history, setHistory] = useState<ResourceUsageSample[]>([]);
  useEffect(() => subscribeResources(peonId, (sample) => {
    if (!sample) return;
    setHistory((current) => {
      // A just-created sampler has no meaningful CPU interval yet. Older Peons
      // reported that near-zero window as a dramatic spike; normalize the first
      // browser sample too so mixed-version fleets draw a calm, honest start.
      const next = current.length ? sample : { ...sample, host: { ...sample.host, cpuPercent: 0 }, process: { ...sample.process, cpuPercent: 0 } };
      return [...current, next].slice(-MAX_SAMPLES);
    });
  }), [peonId, subscribeResources]);
  const latest = history.at(-1);
  const hostCpu = useMemo(() => history.map((sample) => sample.host.cpuPercent), [history]);
  const peonCpu = useMemo(() => history.map(peonCpuPercent), [history]);
  const hostMemory = useMemo(() => history.map(memoryPercent), [history]);
  return <section aria-labelledby="resource-monitor-title">
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><h3 id="resource-monitor-title" className="font-display text-sm font-bold text-ink">Resource monitor</h3><p className="mt-1 font-mono text-xs text-ink-faint">Live history starts when this page opens and stays only in this tab.</p></div>{latest && <span className="flex items-center gap-1.5 font-mono text-[11px] text-accent-strong"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />Live · {new Date(latest.sampledAt).toLocaleTimeString()}</span>}</div>
    {!latest ? <Card className="grid min-h-36 place-items-center px-5 py-8 text-center"><div><Activity className="mx-auto mb-3 animate-pulse text-ink-faint" size={22} /><p className="font-mono text-xs text-ink-muted">Waiting for resource samples…</p></div></Card> : <div className="grid gap-4 xl:grid-cols-2">
      <LiveChart title="CPU load" icon={Cpu} primary={hostCpu} primaryValue={latest.host.cpuPercent} secondary={peonCpu} secondaryValue={peonCpuPercent(latest)} detail={`${latest.host.logicalCpuCount} logical CPUs · load ${latest.host.loadAverage.map((v) => v.toFixed(2)).join(" / ")}`} />
      <LiveChart title="Memory allocated" icon={MemoryStick} primary={hostMemory} primaryValue={memoryPercent(latest)} detail={`${bytes(latest.host.memoryTotalBytes - latest.host.memoryFreeBytes)} of ${bytes(latest.host.memoryTotalBytes)} · includes system cache · Peon RSS ${bytes(latest.process.rssBytes)}`} />
      <Card className="px-5 py-4 xl:col-span-2"><div className="flex items-center justify-between gap-5"><div className="min-w-0"><div className="flex items-center gap-2"><Database size={15} className="text-ink-muted" aria-hidden /><h3 className="font-display text-sm font-bold text-ink">Disk</h3></div><p className="mt-1.5 font-mono text-[11px] text-ink-faint">{bytes(latest.disk.availableBytes)} available of {bytes(latest.disk.totalBytes)}</p></div><strong className="font-mono text-xl tabular-nums text-ink">{pct(latest.disk.usedPercent)}</strong></div><div className="mt-3 h-1.5 overflow-hidden rounded-full bg-surface-hover"><div className="h-full rounded-full bg-accent/75 transition-[width] duration-500" style={{ width: pct(latest.disk.usedPercent) }} /></div></Card>
    </div>}
  </section>;
}
