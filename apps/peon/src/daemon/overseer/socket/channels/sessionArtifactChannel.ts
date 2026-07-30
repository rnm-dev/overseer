import { statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { FileAccessService } from "../../../files/index.js";
import { sessions, type SessionRecord } from "../../../sessions/index.js";
import type { PeonSocketChannel, PeonSocketFrame, PeonSocketSender } from "../peonSocketProtocol.js";
import { SESSION_ARTIFACT_CAPABILITY } from "./projectFileReadChannel.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SessionFiles {
  get(id: string): SessionRecord | undefined;
  preview(id: string, filePath: string, author?: string): unknown;
}

export class SessionArtifactChannel implements PeonSocketChannel {
  readonly capability = SESSION_ARTIFACT_CAPABILITY;
  private accepted = false;
  private readonly watchers = new Map<string, { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(
    private readonly sessionFiles: SessionFiles = sessions,
    private readonly files = new FileAccessService(),
  ) {}

  helloState(): PeonSocketFrame { return {}; }
  started(_sender: PeonSocketSender): void {}
  connecting(): void {}
  negotiated(accepted: boolean): void { this.accepted = accepted; }
  disconnected(): void {
    this.accepted = false;
    for (const requestId of [...this.watchers.keys()]) this.closeWatch(requestId);
  }
  handles(frame: PeonSocketFrame): boolean {
    return frame.type === "artifact_request" || frame.type === "artifact_watch" || frame.type === "artifact_cancel";
  }

  receive(frame: PeonSocketFrame, sender: PeonSocketSender): void {
    if (!this.accepted) return sender.disconnect("unnegotiated session artifact operation");
    const requestId = typeof frame.requestId === "string" && UUID.test(frame.requestId) ? frame.requestId : null;
    if (!requestId || frame.protocol !== 1) return sender.disconnect("invalid session artifact request");
    if (frame.type === "artifact_cancel") {
      this.closeWatch(requestId);
      return;
    }
    try {
      const sessionId = typeof frame.sessionId === "string" && frame.sessionId.length <= 512 ? frame.sessionId : "";
      const record = this.sessionFiles.get(sessionId);
      if (!record) return this.reply(sender, requestId, 404, "UNKNOWN_SESSION", "unknown session");
      const requested = typeof frame.path === "string" && frame.path.length <= 4096 ? frame.path : "";
      if (requested.includes("\0") || requested.includes("\\") || requested.split("/").includes("..")) {
        return this.reply(sender, requestId, 400, "INVALID_PATH", "invalid session artifact path");
      }
      const actor = frame.actor as Record<string, unknown> | undefined;
      if (!actor || typeof actor.userId !== "string" || !actor.userId
        || typeof actor.email !== "string" || !actor.email) {
        return this.reply(sender, requestId, 400, "INVALID_ACTOR", "trusted actor is required");
      }
      const absolute = this.files.resolveWithinDir(record.dir, requested);
      if (!absolute) return this.reply(sender, requestId, 400, "PATH_ESCAPE", "artifact path escapes the session root");

      if (frame.type === "artifact_watch") {
        if (this.watchers.has(requestId)) return this.reply(sender, requestId, 409, "DUPLICATE_REQUEST", "artifact watch already exists");
        if (this.watchers.size >= 16) return this.reply(sender, requestId, 429, "TRANSFER_BUSY", "too many active artifact watches");
        if (!statSync(absolute).isFile()) return this.reply(sender, requestId, 400, "IS_DIRECTORY", "path is not a file");
        const filename = path.basename(absolute);
        const state: { watcher: FSWatcher; timer: ReturnType<typeof setTimeout> | null } = {
          watcher: null as unknown as FSWatcher,
          timer: null,
        };
        state.watcher = watch(path.dirname(absolute), (_event, changed) => {
          if (changed !== null && String(changed) !== filename || state.timer) return;
          state.timer = setTimeout(() => {
            state.timer = null;
            if (!sender.send({ type: "artifact_changed", requestId, path: requested })) {
              this.closeWatch(requestId);
              sender.disconnect("session artifact watch backpressure limit exceeded");
            }
          }, 150);
          state.timer.unref();
        });
        state.watcher.on("error", () => {
          this.closeWatch(requestId);
          this.reply(sender, requestId, 500, "WATCH_FAILED", "artifact watch failed");
        });
        this.watchers.set(requestId, state);
        if (!sender.send({ type: "artifact_watching", requestId, path: requested })) {
          this.closeWatch(requestId);
          sender.disconnect("session artifact watch admission backpressure limit exceeded");
        }
        return;
      }
      if (frame.operation === "list") {
        const entries = this.files.listDirEntries(record.dir, absolute);
        return this.reply(sender, requestId, 200, "OK", null, { path: requested, entries });
      }
      if (frame.operation === "view") {
        return this.reply(sender, requestId, 200, "OK", null, { ...this.files.readFileView(absolute), path: requested });
      }
      if (frame.operation === "preview") {
        if (!requested || !statSync(absolute).isFile()) return this.reply(sender, requestId, 400, "IS_DIRECTORY", "path is not a file");
        const event = this.sessionFiles.preview(record.id, absolute, actor.email);
        return this.reply(sender, requestId, 201, "OK", null, { event });
      }
      return this.reply(sender, requestId, 400, "BAD_OPERATION", "unsupported session artifact operation");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return this.reply(sender, requestId, 404, "NOT_FOUND", "artifact does not exist");
      if (code === "EACCES" || code === "EPERM") return this.reply(sender, requestId, 403, "FORBIDDEN", "artifact is not readable");
      if (code === "EISDIR" || code === "EINVAL") return this.reply(sender, requestId, 400, "IS_DIRECTORY", "path is not a file");
      return this.reply(sender, requestId, 500, "INTERNAL", "session artifact operation failed");
    }
  }

  private closeWatch(requestId: string): void {
    const state = this.watchers.get(requestId);
    if (!state) return;
    this.watchers.delete(requestId);
    if (state.timer) clearTimeout(state.timer);
    state.watcher.close();
  }

  private reply(
    sender: PeonSocketSender,
    requestId: string,
    status: number,
    code: string,
    message: string | null,
    body?: unknown,
  ): void {
    if (!sender.send({ type: "artifact_result", requestId, status, code, message, ...(body === undefined ? {} : { body }) })) {
      sender.disconnect("session artifact result backpressure limit exceeded");
    }
  }
}
