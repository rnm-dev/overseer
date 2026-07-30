import { createHash } from "node:crypto";
import { DeterministicTransport, HarnessLimitError } from "./faultTransport.js";

export class FileWriteHarnessError extends HarnessLimitError {}

function fingerprint(frame) {
  return createHash("sha256").update(JSON.stringify({
    operation: frame.operation, scope: frame.scope, projectId: frame.projectId,
    relativePath: frame.relativePath, path: frame.path, destination: frame.destination,
    contentLength: frame.contentLength, sha256: frame.sha256, actor: frame.actor,
  })).digest("hex");
}

function safePath(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/")
    && !value.split("/").includes("..") && !value.includes("\0");
}

export class FileWriteLifecycleHarness {
  constructor(options = {}) {
    this.transport = options.transport ?? new DeterministicTransport(options);
    this.maxChunkBytes = options.maxChunkBytes ?? 65_514;
    this.maxBodyBytes = options.maxBodyBytes ?? 100 * 1024 * 1024;
    this.initialCredit = options.initialCredit ?? this.maxChunkBytes;
    this.active = new Map();
    this.completed = new Map();
    this.tombstones = new Set();
    this.files = new Map(options.files ?? []);
    this.temps = new Set();
  }

  open(frame) {
    const hash = fingerprint(frame);
    const replay = this.completed.get(frame.requestId);
    if (replay) {
      if (replay.hash !== hash) throw new FileWriteHarnessError("REQUEST_ID_REUSE", "request ID reused with different input");
      return structuredClone(replay.result);
    }
    if (this.active.has(frame.requestId)) throw new FileWriteHarnessError("DUPLICATE_REQUEST", "write already active");
    if (frame.transferId !== frame.requestId || !frame.commandId) throw new FileWriteHarnessError("BAD_CORRELATION", "transfer/command correlation mismatch");
    const source = frame.relativePath ?? frame.path;
    if (!safePath(source) || (frame.destination !== undefined && !safePath(frame.destination))) {
      throw new FileWriteHarnessError("PATH_ESCAPE", "write path escapes root");
    }
    if (frame.contentLength !== undefined && frame.contentLength > this.maxBodyBytes) {
      throw new FileWriteHarnessError("FILE_TOO_LARGE", "declared body exceeds limit");
    }
    if (frame.operation === "move") return this.#move(frame, hash);
    const temp = `.tmp-${frame.requestId}`;
    this.temps.add(temp);
    this.active.set(frame.requestId, {
      frame: structuredClone(frame), hash, generation: this.transport.generation,
      credit: this.initialCredit, nextSequence: 0, chunks: [], received: 0, temp,
    });
    return { type: "write_ready", requestId: frame.requestId, maxBytes: this.maxBodyBytes, credit: this.initialCredit };
  }

  chunk(requestId, sequence, bytes, generation = this.transport.generation) {
    const item = this.active.get(requestId);
    if (!item || generation !== this.transport.generation || item.generation !== generation) return false;
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (bytes.length <= 0 || bytes.length > this.maxChunkBytes || bytes.length > item.credit) {
      throw new FileWriteHarnessError("CREDIT_EXCEEDED", "chunk exceeds credit or frame bound");
    }
    if (sequence !== item.nextSequence) throw new FileWriteHarnessError("BAD_SEQUENCE", "chunk sequence reordered");
    if (item.received + bytes.length > this.maxBodyBytes
      || item.frame.contentLength !== undefined && item.received + bytes.length > item.frame.contentLength) {
      throw new FileWriteHarnessError("FILE_TOO_LARGE", "body exceeds declared or configured limit");
    }
    item.credit -= bytes.length;
    item.received += bytes.length;
    item.nextSequence += 1;
    item.chunks.push(Buffer.from(bytes));
    return { type: "write_credit", requestId, bytes: bytes.length };
  }

  grant(requestId, bytes) {
    const item = this.active.get(requestId);
    if (!item) return false;
    item.credit += bytes;
    return true;
  }

  end(requestId, options = {}) {
    const item = this.active.get(requestId);
    if (!item) return false;
    const body = Buffer.concat(item.chunks);
    if (item.frame.contentLength !== undefined && body.length !== item.frame.contentLength) {
      return this.#fail(item, "LENGTH_MISMATCH");
    }
    const digest = createHash("sha256").update(body).digest("hex");
    if (item.frame.sha256 && item.frame.sha256 !== digest) return this.#fail(item, "CHECKSUM_MISMATCH");
    if (options.symlinkSwap) return this.#fail(item, "PATH_ESCAPE");
    const path = item.frame.relativePath ?? item.frame.path;
    this.files.set(path, Buffer.from(body)); // atomic visibility: only after all validation.
    this.temps.delete(item.temp);
    this.active.delete(requestId);
    const result = { type: "write_result", requestId, status: 201, path, size: body.length, sha256: digest };
    this.completed.set(requestId, { hash: item.hash, result });
    this.tombstones.add(requestId);
    return structuredClone(result);
  }

  cancel(requestId) {
    const item = this.active.get(requestId);
    if (!item) return false;
    this.active.delete(requestId);
    this.temps.delete(item.temp);
    this.tombstones.add(requestId);
    return true;
  }

  reconnect() {
    this.transport.restart("peon");
    for (const requestId of [...this.active.keys()]) this.cancel(requestId);
  }

  #fail(item, code) {
    this.active.delete(item.frame.requestId);
    this.temps.delete(item.temp);
    this.tombstones.add(item.frame.requestId);
    const result = { type: "write_error", requestId: item.frame.requestId, status: 409, code, message: "file write rejected" };
    this.completed.set(item.frame.requestId, { hash: item.hash, result });
    return result;
  }

  #move(frame, hash) {
    if (frame.scope !== "project" || !safePath(frame.destination)) throw new FileWriteHarnessError("PATH_ESCAPE", "move must stay in one project");
    if (!this.files.has(frame.relativePath)) throw new FileWriteHarnessError("NOT_FOUND", "move source missing");
    if (this.files.has(frame.destination)) throw new FileWriteHarnessError("DESTINATION_EXISTS", "move never clobbers");
    const body = this.files.get(frame.relativePath);
    this.files.delete(frame.relativePath);
    this.files.set(frame.destination, body);
    const result = { type: "write_result", requestId: frame.requestId, status: 200, path: frame.destination, size: body.length };
    this.completed.set(frame.requestId, { hash, result });
    this.tombstones.add(frame.requestId);
    return structuredClone(result);
  }
}
