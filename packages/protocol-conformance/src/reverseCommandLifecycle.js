import { createHash } from "node:crypto";
import { BoundedDiagnostics } from "./diagnostics.js";
import { DeterministicDeliveryHarness, DeterministicTransport, HarnessLimitError } from "./faultTransport.js";

function clone(value) {
  return structuredClone(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestHash(command) {
  return createHash("sha256").update(canonical(command)).digest("hex");
}

export class CommandLifecycleError extends HarnessLimitError {}

export class PeonCommandAdapter {
  constructor(options = {}) {
    this.maxCommands = options.maxCommands ?? 32;
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics();
    this.ledger = new Map();
    this.effectIds = new Set();
  }

  admit(command) {
    const hash = requestHash(command);
    const existing = this.ledger.get(command.commandId);
    if (existing) {
      if (existing.hash !== hash) return { kind: "conflict", frame: this.#result(command, "conflict", "COMMAND_ID_REUSED") };
      return { kind: "replayed", frame: this.#accepted(existing, true) };
    }
    if (this.ledger.size >= this.maxCommands) throw new CommandLifecycleError("COMMAND_LEDGER_FULL", "Peon command ledger is full");
    const record = { command: clone(command), hash, state: "accepted", acceptedAt: command.requestedAt + 1, result: null };
    this.ledger.set(command.commandId, record);
    return { kind: "new", frame: this.#accepted(record, false) };
  }

  execute(commandId, options = {}) {
    const record = this.ledger.get(commandId);
    if (!record) return null;
    if (!record.result) {
      this.effectIds.add(commandId);
      record.state = "running";
      if (options.fault === "after-effect") return null;
      record.result = this.#result(record.command, "applied", "OK", {
        sessionId: record.command.target.sessionId,
        sessionStatus: "cancelled",
      });
      record.state = "terminal";
    }
    return clone(record.result);
  }

  status(commandId) {
    const record = this.ledger.get(commandId);
    return {
      type: "command_status",
      protocol: 1,
      commandId,
      state: record?.state ?? "unknown",
      ...(record?.state === "terminal" ? { result: clone(record.result) } : {}),
    };
  }

  restart() {
    this.diagnostics.add("command_peon_state_restored", { commands: this.ledger.size, effects: this.effectIds.size });
  }

  corrupt(commandId) {
    const record = this.ledger.get(commandId);
    if (record) record.hash = "torn";
  }

  recover() {
    for (const [commandId, record] of this.ledger) {
      if (record.hash !== requestHash(record.command)) {
        this.ledger.delete(commandId);
        this.diagnostics.add("command_torn_record_rejected", { commandId });
      }
    }
  }

  #accepted(record, replayed) {
    return {
      type: "command_accepted",
      protocol: 1,
      commandId: record.command.commandId,
      operation: record.command.operation,
      state: "accepted",
      replayed,
      acceptedAt: record.acceptedAt,
    };
  }

  #result(command, status, code, result = null) {
    return {
      type: "command_result",
      protocol: 1,
      commandId: command.commandId,
      operation: command.operation,
      status,
      code,
      completedAt: command.requestedAt + 2,
      result,
    };
  }
}

export class OverseerCommandAdapter {
  constructor(options = {}) {
    this.maxCommands = options.maxCommands ?? 32;
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics();
    this.registry = new Map();
    this.audit = new Set();
    this.browserEvents = new Set();
    this.projectionEffects = new Set();
  }

  persist(command, generation) {
    const hash = requestHash(command);
    const existing = this.registry.get(command.commandId);
    if (existing) {
      if (existing.hash !== hash) throw new CommandLifecycleError("COMMAND_ID_REUSED", "command ID reused with a different request");
      return clone(existing);
    }
    if (this.registry.size >= this.maxCommands) throw new CommandLifecycleError("COMMAND_REGISTRY_FULL", "Overseer command registry is full");
    const record = { command: clone(command), hash, generation, state: "created", result: null, durableCursor: 0 };
    this.registry.set(command.commandId, record);
    return clone(record);
  }

  receiveAccepted(frame, generation) {
    const record = this.registry.get(frame.commandId);
    if (!record || record.generation !== generation) return false;
    record.state = "accepted";
    return true;
  }

  rebind(commandId, generation) {
    const record = this.registry.get(commandId);
    if (!record) return false;
    record.generation = generation;
    return true;
  }

  receiveStatus(frame, generation) {
    const record = this.registry.get(frame.commandId);
    if (!record || record.generation !== generation) return false;
    if (frame.state === "accepted" || frame.state === "running") record.state = "accepted";
    return true;
  }

  commitResult(frame, cursor, generation) {
    const result = frame.payload ?? frame;
    const record = this.registry.get(result.commandId);
    if (!record || record.generation !== generation) return false;
    if (record.state === "terminal") return record.durableCursor === cursor;
    record.state = "terminal";
    record.result = clone(result);
    record.durableCursor = cursor;
    this.audit.add(result.commandId);
    this.browserEvents.add(result.commandId);
    this.projectionEffects.add(result.commandId);
    return true;
  }

  restart() {
    this.diagnostics.add("command_overseer_state_restored", {
      commands: this.registry.size,
      terminal: [...this.registry.values()].filter((record) => record.state === "terminal").length,
    });
  }

  corrupt(commandId) {
    const record = this.registry.get(commandId);
    if (record) record.hash = "torn";
  }

  recover() {
    for (const [commandId, record] of this.registry) {
      if (record.hash !== requestHash(record.command)) {
        this.registry.delete(commandId);
        this.diagnostics.add("command_torn_registry_rejected", { commandId });
      }
    }
  }
}

export class ReverseCommandLifecycleHarness {
  constructor(options = {}) {
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics();
    this.transport = options.transport ?? new DeterministicTransport({ diagnostics: this.diagnostics });
    this.peon = new PeonCommandAdapter({ ...options, diagnostics: this.diagnostics });
    this.overseer = new OverseerCommandAdapter({ ...options, diagnostics: this.diagnostics });
    this.results = new DeterministicDeliveryHarness({
      ...options,
      transport: this.transport,
      diagnostics: this.diagnostics,
    });
  }

  submit(command, fault = "deliver") {
    this.overseer.persist(command, this.transport.generation);
    const sent = this.transport.send(command, { fault });
    let accepted = null;
    for (const envelope of sent) {
      if (!this.transport.accepts(envelope)) continue;
      const admission = this.peon.admit(envelope.frame);
      accepted = admission.frame;
    }
    return accepted;
  }

  deliverAccepted(frame, fault = "deliver") {
    if (!frame) return false;
    return this.transport.send(frame, { fault }).some((envelope) => (
      this.transport.accepts(envelope)
      && this.overseer.receiveAccepted(envelope.frame, envelope.generation)
    ));
  }

  execute(commandId, options = {}) {
    const result = this.peon.execute(commandId, options);
    if (!result) return null;
    const message = this.results.append(result, { messageId: `result:${commandId}` });
    return message.cursor;
  }

  deliverResult(cursor, dataFault = "deliver", ackFault = "deliver") {
    const envelopes = this.results.sendCursor(cursor, dataFault);
    const current = envelopes.filter((envelope) => this.transport.accepts(envelope));
    let committed = false;
    for (const envelope of current) {
      committed = this.overseer.commitResult(envelope.frame, envelope.frame.cursor, envelope.generation) || committed;
    }
    const ack = this.results.receive(current);
    if (committed) this.results.acknowledge(ack, ackFault);
    return committed;
  }

  reconnect(side) {
    this.transport.restart(side);
    this.peon.restart();
    this.overseer.restart();
    for (const commandId of this.overseer.registry.keys()) this.overseer.rebind(commandId, this.transport.generation);
    return this.transport.generation;
  }

  reconcile(commandId, fault = "deliver") {
    const request = { type: "command_status_request", protocol: 1, commandId };
    const requests = this.transport.send(request, { fault });
    let response = null;
    for (const envelope of requests) {
      if (this.transport.accepts(envelope)) response = this.peon.status(commandId);
    }
    if (!response) return null;
    for (const envelope of this.transport.send(response)) {
      if (this.transport.accepts(envelope)) this.overseer.receiveStatus(envelope.frame, envelope.generation);
    }
    return response;
  }

  state(commandId) {
    const peon = this.peon.ledger.get(commandId);
    const overseer = this.overseer.registry.get(commandId);
    return {
      peon: peon?.state ?? "unknown",
      overseer: overseer?.state ?? "unknown",
      effects: this.peon.effectIds.size,
      audits: this.overseer.audit.size,
      browserEvents: this.overseer.browserEvents.size,
      projectionEffects: this.overseer.projectionEffects.size,
      acknowledgedCursor: this.results.acknowledgedCursor,
    };
  }
}
