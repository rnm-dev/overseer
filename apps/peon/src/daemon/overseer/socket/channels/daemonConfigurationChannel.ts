import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import type { ReverseCommandExecution, ReverseCommandHandler, ValidCommand } from "./reverseCommandChannel.js";
import {
  DAEMON_CONFIGURATION_CAPABILITY,
  DaemonConfigurationState,
  settings,
  type DaemonConfigurationSnapshot,
  type SettingsService,
} from "../../../settings/index.js";

const EXPECTED_KEYS = ["epoch", "revision", "digest"];
const PATCH_KEYS = ["name", "defaultAgent", "fileTransferRoot", "heartbeatIntervalMs", "aiDefaultModel", "soul"];
const strictKeys = (value: PeonSocketFrame, allowed: string[]) => Object.keys(value).every((key) => allowed.includes(key));

function publicResult(snapshot: DaemonConfigurationSnapshot, previousRevision: number, changedFields: string[]): PeonSocketFrame {
  return { epoch: snapshot.epoch, previousRevision, revision: snapshot.revision, schemaVersion: snapshot.schemaVersion,
    digest: snapshot.digest, updatedAt: snapshot.updatedAt, changedFields,
    restart: { required: false, components: [] }, errors: [], values: snapshot.values };
}

export class DaemonConfigurationChannel implements PeonSocketChannel {
  readonly capability = DAEMON_CONFIGURATION_CAPABILITY;
  private sender: PeonSocketSender | null = null;
  private accepted = false;
  private unsubscribe: (() => void) | null = null;
  constructor(
    readonly state = new DaemonConfigurationState(),
    private readonly configuration: SettingsService = settings,
  ) {}

  helloState(): PeonSocketFrame {
    const { values: _values, updatedAt: _updatedAt, ...identity } = this.state.snapshot();
    return identity;
  }
  started(_sender: PeonSocketSender): void {
    this.unsubscribe?.();
    const onChange = () => { const current = this.state.reconcile(); if (current.changed) this.publish(current.snapshot, "local_change"); };
    this.configuration.on("change", onChange);
    this.unsubscribe = () => this.configuration.off("change", onChange);
  }
  connecting(): void {}
  negotiated(accepted: boolean, acknowledgement: PeonSocketFrame, sender: PeonSocketSender): void {
    this.accepted = accepted && sender.durable;
    this.sender = this.accepted ? sender : null;
    if (!accepted) return;
    if (!sender.durable) return sender.disconnect("daemon configuration requires durable-delivery-v1");
    const snapshot = this.state.snapshot();
    const remote = (acknowledgement.channels as PeonSocketFrame | undefined)?.[this.capability] as PeonSocketFrame | undefined;
    if (remote?.epoch === snapshot.epoch && Number.isSafeInteger(remote.acknowledgedRevision)
      && (remote.acknowledgedRevision as number) > snapshot.revision) {
      return sender.disconnect("daemon configuration acknowledgement is from a future revision");
    }
    if (!(remote?.epoch === snapshot.epoch && remote?.acknowledgedRevision === snapshot.revision && remote?.digest === snapshot.digest)) {
      this.publish(snapshot, "initial_sync");
    }
  }
  disconnected(resetAuthority: boolean): void {
    if (!resetAuthority && this.sender?.durable) return;
    this.accepted = false; this.sender = null;
  }
  handles(_frame: PeonSocketFrame): boolean { return false; }
  receive(_frame: PeonSocketFrame, _sender: PeonSocketSender): void {}

  commandHandler(): ReverseCommandHandler {
    return {
      priority: "control", maxConcurrency: 1,
      validate: (payload, expected) => {
        if (!this.accepted || !this.sender?.durable) {
          return "daemon.configuration.patch requires negotiated daemon-configuration-v1";
        }
        if (!strictKeys(payload, ["patch"]) || !payload.patch || typeof payload.patch !== "object" || Array.isArray(payload.patch)) {
          return "daemon.configuration.patch requires a patch object";
        }
        if (!expected || !strictKeys(expected, EXPECTED_KEYS) || typeof expected.epoch !== "string"
          || !Number.isSafeInteger(expected.revision) || typeof expected.digest !== "string" || !/^[a-f0-9]{64}$/.test(expected.digest)) {
          return "daemon.configuration.patch requires an exact expected configuration identity";
        }
        return strictKeys(payload.patch as PeonSocketFrame, PATCH_KEYS) ? null : "configuration patch contains a forbidden field";
      },
      execute: (command) => this.execute(command),
    };
  }

  private publish(snapshot: DaemonConfigurationSnapshot, reason: "initial_sync" | "local_change" | "command", commandId?: string): boolean {
    if (!this.sender || !this.accepted || !this.sender.durable) return false;
    return this.sender.sendDurable({ type: "daemon_configuration_state", epoch: snapshot.epoch, revision: snapshot.revision,
      schemaVersion: snapshot.schemaVersion, digest: snapshot.digest, updatedAt: snapshot.updatedAt, reason,
      ...(commandId ? { commandId } : {}), values: snapshot.values },
    { priority: "control", capability: this.capability, coalesceKey: "daemon-configuration-state" }).accepted;
  }

  private execute(command: ValidCommand): ReverseCommandExecution {
    const before = this.state.snapshot();
    const expected = command.expected!;
    const patch = command.payload.patch as PeonSocketFrame;
    const alreadyMatches = Object.entries(patch).every(([key, value]) => (before.values as unknown as PeonSocketFrame)[key] === value);
    if (!(expected.epoch === before.epoch && expected.revision === before.revision && expected.digest === before.digest)) {
      return alreadyMatches ? { status: "noop", code: "OK", result: publicResult(before, before.revision, []) }
        : { status: "conflict", code: "REVISION_CONFLICT", result: publicResult(before, before.revision, []) };
    }
    try {
      this.configuration.patchDaemonConfiguration(patch);
      const current = this.state.reconcile();
      const changed = current.snapshot.revision !== before.revision || current.snapshot.digest !== before.digest;
      const changedFields = PATCH_KEYS.filter((key) =>
        (before.values as unknown as PeonSocketFrame)[key] !== (current.snapshot.values as unknown as PeonSocketFrame)[key]);
      if (!changed) return { status: "noop", code: "OK", result: publicResult(current.snapshot, before.revision, []) };
      this.publish(current.snapshot, "command", command.commandId);
      return { status: "applied", code: "OK", result: publicResult(current.snapshot, before.revision, changedFields) };
    } catch {
      return { status: "rejected", code: "INVALID_VALUE",
        result: { errors: [{ code: "INVALID_VALUE", message: "configuration patch rejected" }] } };
    }
  }
}

export const daemonConfigurationChannel = new DaemonConfigurationChannel();
