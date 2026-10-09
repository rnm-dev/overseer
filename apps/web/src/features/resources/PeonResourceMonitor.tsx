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
function points(values: number[], width = 600, height = 128): string { const step = values.length > 1 ? width / (values.length - 1) : width; return values.map((value, index) => `${index * step},${height - Math.max(0, Math.min(100, value)) / 100 * height}`).join(" "); }

function LiveChart({ title, icon: Icon, primary, primaryValue, secondary, secondaryValue, detail }: { title: string; icon: typeof Activity; primary: number[]; primaryValue: number; secondary: number[]; secondaryValue: number; detail: string }) {
  const area = points(primary);
  return <Card className="overflow-hidden p-0">
    <div className="flex items-start justify-between gap-4 px-5 pt-5"><div><div className="flex items-center gap-2 text-ink-muted"><Icon size={15} aria-hidden /><h3 className="font-display text-sm font-bold text-ink">{title}</h3></div><p className="mt-2 font-mono text-xs text-ink-faint">{detail}</p></div><strong className="font-mono text-2xl font-semibold tabular-nums text-ink">{pct(primaryValue)}</strong></div>
    <div className="relative mt-5 h-36 border-t border-line/60 bg-gradient-to-b from-accent/5 to-transparent">
      <div className="pointer-events-none absolute inset-0 grid grid-rows-4">{[0, 1, 2, 3].map((line) => <span key={line} className="border-b border-line/40" />)}</div>
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 600 128" preserveAspectRatio="none" role="img" aria-label={`${title} recent history`}>
        {area && <><polygon points={`0,128 ${area} 600,128`} className="fill-accent/10" /><polyline points={area} className="fill-none stroke-accent" strokeWidth="2.5" vectorEffect="non-scaling-stroke" /></>}
        <polyline points={points(secondary)} className="fill-none stroke-ink-faint" strokeWidth="1.5" strokeDasharray="5 5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="absolute bottom-2 left-4 flex gap-4 font-mono text-[10px] text-ink-faint"><span><i className="mr-1 inline-block h-1.5 w-3 rounded bg-accent" />Host</span><span><i className="mr-1 inline-block h-0 w-3 border-t border-dashed border-ink-faint" />Peon {pct(secondaryValue)}</span></div>
      <span className="absolute right-4 top-2 font-mono text-[10px] text-ink-faint">100%</span>
    </div>
  </Card>;
}

export function PeonResourceMonitor({ peonId }: { peonId: string }) {
  const { subscribeResources } = useLiveSocket();
  const [history, setHistory] = useState<ResourceUsageSample[]>([]);
  useEffect(() => subscribeResources(peonId, (sample) => { if (sample) setHistory((current) => [...current, sample].slice(-MAX_SAMPLES)); }), [peonId, subscribeResources]);
  const latest = history.at(-1);
  const hostCpu = useMemo(() => history.map((sample) => sample.host.cpuPercent), [history]);
  const peonCpu = useMemo(() => history.map(peonCpuPercent), [history]);
  const hostMemory = useMemo(() => history.map(memoryPercent), [history]);
  const peonMemory = useMemo(() => history.map((sample) => sample.process.rssBytes / sample.host.memoryTotalBytes * 100), [history]);
  return <section aria-labelledby="resource-monitor-title">
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3"><div><h3 id="resource-monitor-title" className="font-display text-sm font-bold text-ink">Resource monitor</h3><p className="mt-1 font-mono text-xs text-ink-faint">Live history starts when this page opens and stays only in this tab.</p></div>{latest && <span className="flex items-center gap-1.5 font-mono text-[11px] text-accent-strong"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />Live · {new Date(latest.sampledAt).toLocaleTimeString()}</span>}</div>
    {!latest ? <Card className="grid min-h-36 place-items-center px-5 py-8 text-center"><div><Activity className="mx-auto mb-3 animate-pulse text-ink-faint" size={22} /><p className="font-mono text-xs text-ink-muted">Waiting for resource samples…</p></div></Card> : <div className="grid gap-4 xl:grid-cols-2">
      <LiveChart title="CPU load" icon={Cpu} primary={hostCpu} primaryValue={latest.host.cpuPercent} secondary={peonCpu} secondaryValue={peonCpuPercent(latest)} detail={`${latest.host.logicalCpuCount} logical CPUs · load ${latest.host.loadAverage.map((v) => v.toFixed(2)).join(" / ")}`} />
      <LiveChart title="Memory" icon={MemoryStick} primary={hostMemory} primaryValue={memoryPercent(latest)} secondary={peonMemory} secondaryValue={peonMemory.at(-1) ?? 0} detail={`${bytes(latest.host.memoryTotalBytes - latest.host.memoryFreeBytes)} of ${bytes(latest.host.memoryTotalBytes)} · Peon RSS ${bytes(latest.process.rssBytes)}`} />
      <Card className="px-5 py-5 xl:col-span-2"><div className="flex items-center justify-between gap-5"><div className="min-w-0"><div className="flex items-center gap-2"><Database size={15} className="text-ink-muted" aria-hidden /><h3 className="font-display text-sm font-bold text-ink">Disk</h3></div><p className="mt-2 font-mono text-xs text-ink-faint">{bytes(latest.disk.usedBytes)} used · {bytes(latest.disk.availableBytes)} available · {bytes(latest.disk.totalBytes)} total</p></div><strong className="font-mono text-2xl tabular-nums text-ink">{pct(latest.disk.usedPercent)}</strong></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-surface-hover"><div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: pct(latest.disk.usedPercent) }} /></div></Card>
    </div>}
  </section>;
}
