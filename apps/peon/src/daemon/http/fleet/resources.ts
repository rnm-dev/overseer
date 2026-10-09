import { cpus, freemem, loadavg, totalmem } from "node:os";
import { statfs } from "node:fs/promises";
import type express from "express";

export const RESOURCE_USAGE_CAPABILITY = "resource-usage-v1";
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 10_000;
const MAX_STREAMS = 256;

function cpuTimes(): { idle: number; total: number } {
  let idle = 0; let total = 0;
  for (const cpu of cpus()) { idle += cpu.times.idle; total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0); }
  return { idle, total };
}

export class ResourceSampler {
  private sequence = 0;
  private first = true;
  private previousCpu = cpuTimes();
  private previousProcess = process.cpuUsage();
  private previousAt = process.hrtime.bigint();
  async sample() {
    const nowCpu = cpuTimes(); const nowProcess = process.cpuUsage(); const nowAt = process.hrtime.bigint();
    const elapsedMicros = Number(nowAt - this.previousAt) / 1_000;
    const cpuTotal = nowCpu.total - this.previousCpu.total; const cpuIdle = nowCpu.idle - this.previousCpu.idle;
    const processMicros = nowProcess.user - this.previousProcess.user + nowProcess.system - this.previousProcess.system;
    const first = this.first; this.first = false;
    this.previousCpu = nowCpu; this.previousProcess = nowProcess; this.previousAt = nowAt;
    const memory = process.memoryUsage();
    const filesystem = await statfs(process.cwd(), { bigint: true });
    const totalBytes = filesystem.blocks * filesystem.bsize; const availableBytes = filesystem.bavail * filesystem.bsize;
    const usedBytes = totalBytes - availableBytes;
    return {
      version: RESOURCE_USAGE_CAPABILITY, sampledAt: Date.now(), sequence: ++this.sequence,
      process: { cpuPercent: !first && elapsedMicros > 0 ? Math.max(0, processMicros / elapsedMicros * 100) : 0,
        rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, uptimeSeconds: process.uptime() },
      host: { cpuPercent: !first && cpuTotal > 0 ? Math.max(0, Math.min(100, (cpuTotal - cpuIdle) / cpuTotal * 100)) : 0,
        logicalCpuCount: cpus().length, loadAverage: loadavg(), memoryTotalBytes: totalmem(), memoryFreeBytes: freemem() },
      disk: { totalBytes: Number(totalBytes), usedBytes: Number(usedBytes), availableBytes: Number(availableBytes),
        usedPercent: totalBytes > 0n ? Number(usedBytes * 10_000n / totalBytes) / 100 : 0 },
    };
  }
}

export function attachResourceUsageRoutes(router: express.Router, sampler = new ResourceSampler()): void {
  let streams = 0;
  router.get("/resources", async (_req, res, next) => {
    try { res.setHeader("Cache-Control", "no-store"); res.json(await sampler.sample()); } catch (error) { next(error); }
  });
  router.get("/resources/stream", async (req, res) => {
    if (streams >= MAX_STREAMS) { res.status(429).end(); return; }
    const requested = Number(req.query.intervalMs ?? MIN_INTERVAL_MS);
    if (!Number.isFinite(requested)) { res.status(400).end(); return; }
    const intervalMs = Math.max(MIN_INTERVAL_MS, Math.min(MAX_INTERVAL_MS, Math.round(requested)));
    const streamSampler = new ResourceSampler();
    let closed = false; let timer: ReturnType<typeof setInterval> | undefined; let sampling = false;
    const close = () => { if (closed) return; closed = true; streams--; clearInterval(timer); res.end(); };
    const emit = async () => {
      if (closed || sampling) return; sampling = true;
      try { const sample = await streamSampler.sample(); if (!closed && !res.write(`event: sample\ndata: ${JSON.stringify(sample)}\n\n`)) close(); }
      catch { close(); } finally { sampling = false; }
    };
    streams++;
    res.setHeader("Content-Type", "text/event-stream"); res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Accel-Buffering", "no"); res.flushHeaders(); res.on("close", close);
    await emit(); if (closed) return;
    timer = setInterval(() => void emit(), intervalMs); timer.unref();
  });
}
