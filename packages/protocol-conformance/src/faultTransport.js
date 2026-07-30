import { randomUUID } from "node:crypto";
import { BoundedDiagnostics } from "./diagnostics.js";

export class HarnessLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function clone(value) {
  return structuredClone(value);
}

export class DeterministicTransport {
  constructor(options = {}) {
    this.maxQueuedFrames = options.maxQueuedFrames ?? 128;
    this.maxFrameBytes = options.maxFrameBytes ?? 1024 * 1024;
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics();
    this.connected = true;
    this.generation = 1;
    this.sequence = 0;
    this.held = [];
  }

  send(frame, options = {}) {
    if (!this.connected) {
      this.diagnostics.add("transport_send_while_disconnected", { type: frame?.type });
      return [];
    }
    const bytes = Buffer.byteLength(JSON.stringify(frame), "utf8");
    if (bytes > this.maxFrameBytes) throw new HarnessLimitError("FRAME_TOO_LARGE", `frame exceeds ${this.maxFrameBytes} bytes`);
    const envelope = {
      generation: this.generation,
      sequence: ++this.sequence,
      durable: options.durable === true,
      frame: clone(frame),
    };
    const fault = options.fault ?? "deliver";
    this.diagnostics.add("transport_fault", { fault, generation: this.generation, sequence: envelope.sequence, type: frame.type });
    if (fault === "drop") return [];
    if (fault === "duplicate") return [envelope, clone(envelope)];
    if (fault === "hold") {
      if (this.held.length >= this.maxQueuedFrames) throw new HarnessLimitError("QUEUE_FULL", "held frame queue is full");
      this.held.push(envelope);
      return [];
    }
    if (fault !== "deliver") throw new Error(`unknown deterministic fault ${fault}`);
    return [envelope];
  }

  releaseHeld(order = "fifo") {
    const frames = this.held.splice(0);
    if (order === "reverse") frames.reverse();
    else if (order !== "fifo") throw new Error(`unknown release order ${order}`);
    this.diagnostics.add("transport_release_held", { order, count: frames.length });
    return frames;
  }

  disconnect(reason = "injected disconnect") {
    this.connected = false;
    this.diagnostics.add("transport_disconnected", { reason, generation: this.generation });
  }

  reconnect() {
    this.connected = true;
    this.generation += 1;
    this.diagnostics.add("transport_reconnected", { generation: this.generation });
    return this.generation;
  }

  restart(side) {
    if (side !== "peon" && side !== "overseer") throw new Error("restart side must be peon or overseer");
    this.disconnect(`${side} restart`);
    const generation = this.reconnect();
    this.diagnostics.add("process_restarted", { side, generation });
    return generation;
  }

  accepts(envelope) {
    const accepted = envelope.generation === this.generation;
    if (!accepted) this.diagnostics.add("stale_generation_frame", {
      frameGeneration: envelope.generation,
      currentGeneration: this.generation,
      sequence: envelope.sequence,
    });
    return accepted;
  }
}

export class DeterministicDeliveryHarness {
  constructor(options = {}) {
    this.diagnostics = options.diagnostics ?? new BoundedDiagnostics();
    this.transport = options.transport ?? new DeterministicTransport({ diagnostics: this.diagnostics });
    this.maxMessages = options.maxMessages ?? 128;
    this.maxBytes = options.maxBytes ?? 1024 * 1024;
    this.journal = [];
    this.journalBytes = 0;
    this.acknowledgedCursor = 0;
    this.receiverCursor = 0;
    this.receiverSeen = new Set();
    this.receiverCursors = new Map();
    this.effects = new Map();
  }

  append(payload, options = {}) {
    const message = {
      type: "durable_message",
      epoch: options.epoch ?? "fixture-delivery-epoch",
      cursor: this.journal.length + 1,
      messageId: options.messageId ?? randomUUID(),
      payload: clone(payload),
    };
    const bytes = Buffer.byteLength(JSON.stringify(message), "utf8");
    if (this.journal.length >= this.maxMessages || this.journalBytes + bytes > this.maxBytes) {
      throw new HarnessLimitError("OUTBOX_FULL", "deterministic durable journal is full");
    }
    this.journal.push({ message, bytes });
    this.journalBytes += bytes;
    return clone(message);
  }

  sendCursor(cursor, fault = "deliver") {
    const record = this.journal[cursor - 1];
    if (!record) throw new Error(`unknown durable cursor ${cursor}`);
    return this.transport.send(record.message, { durable: true, fault });
  }

  receive(envelopes) {
    let acknowledgement = null;
    for (const envelope of envelopes) {
      if (!this.transport.accepts(envelope)) continue;
      const message = envelope.frame;
      const cursor = message.cursor;
      if (!Number.isSafeInteger(cursor) || cursor <= 0) continue;
      if (cursor <= this.receiverCursor) {
        const knownMessageId = this.receiverCursors.get(cursor);
        if (knownMessageId !== message.messageId) {
          this.diagnostics.add("durable_cursor_reused", {
            cursor,
            expectedMessageId: knownMessageId,
            receivedMessageId: message.messageId,
          });
          continue;
        }
        this.diagnostics.add("durable_duplicate_deduped", { cursor, messageId: message.messageId });
        acknowledgement = {
          type: "durable_ack",
          epoch: message.epoch,
          cursor: this.receiverCursor,
        };
        continue;
      }
      if (cursor > this.receiverCursor + 1) {
        this.diagnostics.add("durable_gap_detected", { expected: this.receiverCursor + 1, received: cursor });
        continue;
      }
      if (this.receiverSeen.has(message.messageId)) {
        this.diagnostics.add("durable_message_id_reused", { cursor, messageId: message.messageId });
        continue;
      }
      this.receiverSeen.add(message.messageId);
      this.receiverCursors.set(cursor, message.messageId);
      this.effects.set(message.messageId, clone(message.payload));
      this.receiverCursor = Math.max(this.receiverCursor, cursor);
      acknowledgement = {
        type: "durable_ack",
        epoch: message.epoch,
        cursor: this.receiverCursor,
      };
    }
    return acknowledgement;
  }

  acknowledge(frame, fault = "deliver") {
    if (!frame) return;
    const delivered = this.transport.send(frame, { fault });
    for (const envelope of delivered) {
      if (!this.transport.accepts(envelope)) continue;
      const cursor = envelope.frame.cursor;
      if (Number.isSafeInteger(cursor) && cursor >= this.acknowledgedCursor && cursor <= this.journal.length) {
        this.acknowledgedCursor = cursor;
      }
    }
  }

  cycle(options = {}) {
    const cursor = options.cursor ?? this.acknowledgedCursor + 1;
    const acknowledgement = this.receive(this.sendCursor(cursor, options.dataFault));
    this.acknowledge(acknowledgement, options.ackFault);
    return {
      cursor,
      acknowledgement: clone(acknowledgement),
      senderAcknowledgedCursor: this.acknowledgedCursor,
      receiverCursor: this.receiverCursor,
      effects: this.effects.size,
    };
  }

  drain(maxSteps = this.maxMessages * 4) {
    let steps = 0;
    while (this.acknowledgedCursor < this.journal.length && steps < maxSteps) {
      this.cycle();
      steps += 1;
    }
    if (this.acknowledgedCursor !== this.journal.length) {
      throw new HarnessLimitError("CONVERGENCE_TIMEOUT", `did not converge in ${maxSteps} steps`);
    }
    return { steps, effects: this.effects.size, acknowledgedCursor: this.acknowledgedCursor };
  }

  restart(side) {
    this.transport.restart(side);
    this.diagnostics.add("durable_state_restored", {
      side,
      journalMessages: this.journal.length,
      acknowledgedCursor: this.acknowledgedCursor,
      receiverCursor: this.receiverCursor,
    });
  }

  state() {
    return {
      journalMessages: this.journal.length,
      journalBytes: this.journalBytes,
      acknowledgedCursor: this.acknowledgedCursor,
      receiverCursor: this.receiverCursor,
      effects: this.effects.size,
    };
  }
}
