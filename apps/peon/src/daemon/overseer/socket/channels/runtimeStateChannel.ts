import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { settings } from "../../../settings/index.js";
import { sessions } from "../../../sessions/index.js";
import { listAgentDrivers } from "../../../agents/index.js";
import { modelCatalog } from "../../../modelCatalog.js";
import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";

export const RUNTIME_STATE_CAPABILITY = "runtime-state-v1";
const MAX_RUNTIME_STATE_BYTES = 56 * 1024;
const FORBIDDEN_RUNTIME_KEY = /(?:credential|secret|token|password|authorization|authresponse|environment|executablepath|filetransferroot)/i;

function packageVersion(): string {
  try {
    const path = fileURLToPath(new URL("../../../../../package.json", import.meta.url));
    return String((JSON.parse(readFileSync(path, "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    return "unknown";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function hasForbiddenRuntimeKey(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value as object)) return true;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some((item) => hasForbiddenRuntimeKey(item, seen));
  return Object.entries(value as Record<string, unknown>).some(
    ([key, nested]) => FORBIDDEN_RUNTIME_KEY.test(key) || hasForbiddenRuntimeKey(nested, seen),
  );
}

export class RuntimeStateChannel implements PeonSocketChannel {
  readonly capability = RUNTIME_STATE_CAPABILITY;
  private readonly epoch = randomUUID();
  private revision = 0;
  private digest = "";
  private sender: PeonSocketSender | null = null;
  private accepted = false;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly readState: () => PeonSocketFrame = () => RuntimeStateChannel.defaultState(),
    private readonly subscribe: (listener: () => void) => () => void = (listener) => {
      settings.on("change", listener);
      sessions.on("change", listener);
      return () => {
        settings.off("change", listener);
        sessions.off("change", listener);
      };
    },
  ) {}

  helloState(): PeonSocketFrame {
    return { protocol: 1, epoch: this.epoch, revision: this.revision, digest: this.digest || null };
  }

  started(sender: PeonSocketSender): void {
    this.accepted = false;
    this.sender = null;
    this.unsubscribe ??= this.subscribe(() => this.publish());
  }

  connecting(): void {}

  negotiated(accepted: boolean, _ack: PeonSocketFrame, sender: PeonSocketSender): void {
    if (accepted && !sender.durable) return sender.disconnect("runtime state requires durable-delivery-v1");
    this.accepted = accepted && sender.durable;
    this.sender = this.accepted ? sender : null;
    if (accepted) this.publish(true);
  }

  disconnected(resetAuthority: boolean): void {
    if (resetAuthority) {
      this.accepted = false;
      this.sender = null;
    }
  }

  handles(): boolean { return false; }
  receive(): void {}

  private static defaultState(): PeonSocketFrame {
    const current = settings.get();
    const providers = listAgentDrivers({ visible: true }).map((driver) => ({
      id: driver.id,
      available: driver.available(),
      capabilities: { ...driver.capabilities },
    }));
    return {
      name: current.name || null,
      paused: current.paused,
      filesEnabled: Boolean(current.fileTransferRoot),
      capacity: { active: sessions.activeCount(), total: sessions.list().length },
      daemon: { version: packageVersion(), revision: process.env.PEON_REVISION?.slice(0, 80) ?? null },
      defaultAgent: current.defaultAgent,
      providers,
      models: modelCatalog(current.defaultAgent, current.ai.defaultModel, current.ai.defaultReasoningEffort),
    };
  }

  private publish(force = false): void {
    const sender = this.sender;
    if (!this.accepted || !sender?.durable) return;
    const liveState = this.readState();
    if (hasForbiddenRuntimeKey(liveState)) {
      sender.disconnect("runtime state contains a forbidden sensitive key");
      return;
    }
    let state: PeonSocketFrame;
    let serialized: string;
    try {
      serialized = JSON.stringify(liveState);
      state = JSON.parse(serialized) as PeonSocketFrame;
    } catch {
      sender.disconnect("runtime state is not JSON serializable");
      return;
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_RUNTIME_STATE_BYTES) {
      sender.disconnect("runtime state exceeds the negotiated payload bound");
      return;
    }
    const encoded = canonical(state);
    const digest = createHash("sha256").update(encoded).digest("hex");
    if (!force && digest === this.digest) return;
    if (digest !== this.digest) this.revision += 1;
    this.digest = digest;
    sender.sendDurable({
      type: "runtime_state",
      protocol: 1,
      epoch: this.epoch,
      revision: this.revision,
      digest,
      generatedAt: Date.now(),
      state,
    }, {
      capability: this.capability,
      priority: "normal",
      dedupeKey: `runtime-state:${this.epoch}:${this.revision}`,
      coalesceKey: "runtime-state",
    });
  }
}
