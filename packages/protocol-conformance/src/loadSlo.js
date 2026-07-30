import { BoundedDiagnostics } from "./diagnostics.js";
import { HarnessLimitError } from "./faultTransport.js";

const CLASSES = ["control", "control", "control", "control", "durable", "durable", "transfer"];

function queueSize(queues) {
  return [...queues.values()].reduce((total, queue) => total + queue.length, 0);
}

function positiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export class ProportionalLoadHarness {
  constructor(options = {}) {
    this.maxQueued = positiveSafeInteger(options.maxQueued ?? 256, "maxQueued");
    this.maxPerFlow = positiveSafeInteger(options.maxPerFlow ?? 32, "maxPerFlow");
    this.maxReconnects = positiveSafeInteger(options.maxReconnects ?? 32, "maxReconnects");
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics({
      maxEntries: options.maxDiagnosticEntries ?? 64,
      maxBytes: options.maxDiagnosticBytes ?? 16 * 1024,
      clock: () => this.now,
    });
    this.now = 0;
    this.slot = 0;
    this.nextId = 0;
    this.peakQueued = 0;
    this.reconnects = 0;
    this.reconnectRejected = 0;
    this.queues = {
      control: new Map(),
      transfer: new Map(),
    };
    this.durable = [];
    this.flowCursor = { control: 0, transfer: 0 };
    this.credits = new Map();
    this.completed = [];
    this.latencies = { control: [], durable: [], transfer: [] };
    this.completedByFlow = new Map();
    this.durableDispatch = [];
  }

  enqueue(kind, flow, detail = {}) {
    if (!["control", "durable", "transfer"].includes(kind)) throw new Error(`unknown load class ${kind}`);
    if (this.queued >= this.maxQueued) throw new HarnessLimitError("QUEUE_FULL", "load queue bound reached");
    const task = {
      id: ++this.nextId,
      kind,
      flow: String(flow),
      enqueuedAt: this.now,
      sequence: detail.sequence ?? null,
      bytes: detail.bytes ?? 0,
      operation: detail.operation ?? "work",
    };
    if (kind === "durable") {
      if (!Number.isSafeInteger(task.sequence) || task.sequence <= 0) throw new Error("durable sequence is required");
      const last = this.durable.at(-1)?.sequence ?? this.durableDispatch.at(-1) ?? 0;
      if (task.sequence !== last + 1) throw new HarnessLimitError("DURABLE_REORDER", "durable enqueue order must be contiguous");
      this.durable.push(task);
    } else {
      const queues = this.queues[kind];
      const queue = queues.get(task.flow) ?? [];
      if (queue.length >= this.maxPerFlow) throw new HarnessLimitError("FLOW_QUEUE_FULL", `${kind} flow queue bound reached`);
      if (kind === "transfer") {
        const credit = this.credits.get(task.flow) ?? 0;
        if (!Number.isSafeInteger(task.bytes) || task.bytes <= 0 || task.bytes > credit) return false;
        this.credits.set(task.flow, credit - task.bytes);
      }
      queue.push(task);
      queues.set(task.flow, queue);
    }
    this.peakQueued = Math.max(this.peakQueued, this.queued);
    return task.id;
  }

  grantCredit(flow, bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error("credit must be positive");
    const next = (this.credits.get(String(flow)) ?? 0) + bytes;
    if (!Number.isSafeInteger(next)) throw new HarnessLimitError("CREDIT_OVERFLOW", "transfer credit exceeds safe bounds");
    this.credits.set(String(flow), next);
  }

  reconnect() {
    if (this.reconnects >= this.maxReconnects) {
      this.reconnectRejected += 1;
      this.diagnostics.add("reconnect_storm_bounded", { accepted: this.reconnects, rejected: this.reconnectRejected });
      return false;
    }
    this.reconnects += 1;
    this.diagnostics.add("reconnect_admitted", { reconnects: this.reconnects });
    return true;
  }

  step() {
    for (let attempts = 0; attempts < CLASSES.length; attempts += 1) {
      const kind = CLASSES[this.slot % CLASSES.length];
      this.slot += 1;
      const task = kind === "durable" ? this.durable.shift() : this.#nextFlowTask(kind);
      if (!task) continue;
      this.now += 1;
      const latency = this.now - task.enqueuedAt;
      this.latencies[kind].push(latency);
      this.completed.push(task);
      this.completedByFlow.set(task.flow, (this.completedByFlow.get(task.flow) ?? 0) + 1);
      if (kind === "durable") {
        const expected = (this.durableDispatch.at(-1) ?? 0) + 1;
        if (task.sequence !== expected) throw new HarnessLimitError("DURABLE_REORDER", "durable dispatch reordered");
        this.durableDispatch.push(task.sequence);
      } else if (kind === "transfer") {
        this.grantCredit(task.flow, task.bytes);
      }
      return task;
    }
    this.now += 1;
    return null;
  }

  drain(maxSteps = this.maxQueued * 8) {
    let steps = 0;
    while (this.queued > 0 && steps < maxSteps) {
      this.step();
      steps += 1;
    }
    if (this.queued > 0) throw new HarnessLimitError("CONVERGENCE_TIMEOUT", "load queues did not drain");
    return this.summary();
  }

  summary() {
    const maximum = (values) => values.length === 0 ? 0 : Math.max(...values);
    return {
      formatVersion: 1,
      virtualTicks: this.now,
      queued: this.queued,
      peakQueued: this.peakQueued,
      reconnects: this.reconnects,
      reconnectRejected: this.reconnectRejected,
      completed: {
        control: this.latencies.control.length,
        durable: this.latencies.durable.length,
        transfer: this.latencies.transfer.length,
      },
      maxLatencyTicks: {
        control: maximum(this.latencies.control),
        durable: maximum(this.latencies.durable),
        transfer: maximum(this.latencies.transfer),
      },
      durableOrdered: this.durableDispatch.every((sequence, index) => sequence === index + 1),
      diagnostics: this.diagnostics.artifact(),
    };
  }

  get queued() {
    return this.durable.length + queueSize(this.queues.control) + queueSize(this.queues.transfer);
  }

  #nextFlowTask(kind) {
    const queues = this.queues[kind];
    const flows = [...queues.keys()].filter((flow) => (queues.get(flow)?.length ?? 0) > 0).sort();
    if (flows.length === 0) return null;
    const index = this.flowCursor[kind] % flows.length;
    this.flowCursor[kind] += 1;
    const flow = flows[index];
    const queue = queues.get(flow);
    const task = queue.shift();
    if (queue.length === 0) queues.delete(flow);
    return task;
  }
}

export function runDeterministicSoak(options = {}) {
  const durationTicks = positiveSafeInteger(options.durationTicks ?? 10_000, "durationTicks");
  const harness = new ProportionalLoadHarness({
    maxQueued: options.maxQueued ?? 512,
    maxPerFlow: options.maxPerFlow ?? 64,
    maxReconnects: options.maxReconnects ?? 64,
  });
  const transferFlows = ["peon-a/read", "peon-a/write", "peon-b/read", "peon-b/write"];
  for (const flow of transferFlows) harness.grantCredit(flow, 4096);
  let durableSequence = 0;
  let transferIndex = 0;
  for (let burst = 0; burst < 32; burst += 1) {
    for (let index = 0; index < 4; index += 1) {
      harness.enqueue("control", `peon-${index}`, { operation: ["heartbeat", "cancel", "terminal-ack"][index % 3] });
    }
    for (let index = 0; index < 2; index += 1) {
      harness.enqueue("durable", `session-${index}`, { sequence: ++durableSequence, operation: "transcript" });
    }
    const flow = transferFlows[transferIndex % transferFlows.length];
    transferIndex += 1;
    harness.enqueue("transfer", flow, { bytes: 1024, operation: flow.endsWith("read") ? "read" : "write" });
  }
  while (harness.now < durationTicks) {
    for (let index = 0; index < 4; index += 1) {
      harness.enqueue("control", `peon-${index}`, { operation: ["heartbeat", "cancel", "terminal-ack"][index % 3] });
    }
    for (let index = 0; index < 2; index += 1) {
      harness.enqueue("durable", `session-${index}`, { sequence: ++durableSequence, operation: "transcript" });
    }
    const flow = transferFlows[transferIndex % transferFlows.length];
    transferIndex += 1;
    harness.enqueue("transfer", flow, { bytes: 1024, operation: flow.endsWith("read") ? "read" : "write" });
    if (harness.now > 0 && harness.now % 97 === 0) {
      for (let index = 0; index < 4; index += 1) harness.reconnect();
    }
    for (let index = 0; index < CLASSES.length && harness.now < durationTicks; index += 1) harness.step();
  }
  const summary = harness.drain();
  const flowCounts = transferFlows.map((flow) => harness.completedByFlow.get(flow) ?? 0);
  const transferSpread = Math.max(...flowCounts) - Math.min(...flowCounts);
  const criteria = {
    queuesDrained: summary.queued === 0,
    queueBounded: summary.peakQueued <= harness.maxQueued,
    controlLatency: summary.maxLatencyTicks.control <= 256,
    durableLatency: summary.maxLatencyTicks.durable <= 256,
    durableOrdered: summary.durableOrdered,
    transferFair: transferSpread <= 1,
    diagnosticsBounded: summary.diagnostics.bytes <= summary.diagnostics.bounds.maxBytes,
  };
  return {
    ...summary,
    durationTicks,
    transferSpread,
    criteria,
    passed: Object.values(criteria).every(Boolean),
  };
}
