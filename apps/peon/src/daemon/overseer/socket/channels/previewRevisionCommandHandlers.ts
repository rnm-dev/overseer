import type { SessionRecord } from "../../../sessionTypes.js";
import type { PreviewRevisionPublisher } from "../previewRevisionPublisher.js";
import type { PeonSocketFrame } from "../peonSocketProtocol.js";
import type { ReverseCommandHandler, ValidCommand } from "./reverseCommandChannel.js";

export const PREVIEW_REVISION_CAPABILITY = "preview-revision-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_LEASE_MS = 5 * 60_000;

interface SessionReader {
  get(id: string): SessionRecord | undefined;
}

interface LeaseBinding {
  sessionId: string;
  actorId: string;
}

const strictKeys = (value: PeonSocketFrame, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
const validExpiry = (value: unknown, now: number) =>
  Number.isSafeInteger(value) && (value as number) > now && (value as number) <= now + MAX_LEASE_MS;

export function previewRevisionCommandHandlers(options: {
  publisher: PreviewRevisionPublisher;
  sessions: SessionReader;
  negotiated: () => boolean;
  now?: () => number;
}): Record<string, ReverseCommandHandler> {
  const now = options.now ?? Date.now;
  const bindings = new Map<string, LeaseBinding>();

  const validateCommon = (command: ValidCommand): string | null => {
    if (!options.negotiated()) return `${command.operation} requires negotiated ${PREVIEW_REVISION_CAPABILITY}`;
    if (!command.target.sessionId || !options.sessions.get(command.target.sessionId)) return "preview command requires a known session";
    return null;
  };
  const execute = async (command: ValidCommand) => {
    const common = validateCommon(command);
    if (common) return { status: "rejected" as const, code: common.includes("negotiated") ? "UNSUPPORTED_CAPABILITY" : "UNKNOWN_SESSION" };
    const sessionId = command.target.sessionId!;
    const record = options.sessions.get(sessionId)!;
    const leaseId = String(command.payload.leaseId);
    const binding = bindings.get(leaseId);

    if (command.operation === "preview.watch") {
      if (binding) {
        return binding.sessionId === sessionId && binding.actorId === command.actor.userId
          ? { status: "noop" as const, code: "OK", result: { leaseId } }
          : { status: "conflict" as const, code: "LEASE_CONFLICT" };
      }
      try {
        await options.publisher.watch(leaseId, record.dir, String(command.payload.path), Number(command.payload.expiresAt));
        bindings.set(leaseId, { sessionId, actorId: command.actor.userId });
        return { status: "applied" as const, code: "OK", result: { leaseId } };
      } catch (error) {
        return { status: "rejected" as const, code: error instanceof Error ? error.message : "WATCH_FAILED" };
      }
    }
    if (!binding || binding.sessionId !== sessionId || binding.actorId !== command.actor.userId) {
      return { status: "noop" as const, code: "OK", result: { leaseId } };
    }
    if (command.operation === "preview.renew") {
      options.publisher.renew(leaseId, Number(command.payload.expiresAt));
      return { status: "applied" as const, code: "OK", result: { leaseId } };
    }
    options.publisher.unwatch(leaseId);
    bindings.delete(leaseId);
    return { status: "applied" as const, code: "OK", result: { leaseId } };
  };

  const handler = (operation: "preview.watch" | "preview.renew" | "preview.unwatch"): ReverseCommandHandler => ({
    priority: "control",
    maxConcurrency: operation === "preview.watch" ? 4 : 16,
    validate: (payload, expected) => {
      if (expected !== null) return `${operation} does not accept expected state`;
      const allowed = operation === "preview.watch" ? ["leaseId", "path", "expiresAt"]
        : operation === "preview.renew" ? ["leaseId", "expiresAt"] : ["leaseId"];
      if (!strictKeys(payload, allowed) || typeof payload.leaseId !== "string" || !UUID.test(payload.leaseId)) {
        return `${operation} requires a UUID leaseId`;
      }
      if (operation === "preview.watch"
        && (typeof payload.path !== "string" || !payload.path || Buffer.byteLength(payload.path) > 4096)) {
        return "preview.watch requires a bounded path";
      }
      if (operation !== "preview.unwatch" && !validExpiry(payload.expiresAt, now())) {
        return `${operation} requires a future bounded expiresAt`;
      }
      return null;
    },
    execute,
  });

  return {
    "preview.watch": handler("preview.watch"),
    "preview.renew": handler("preview.renew"),
    "preview.unwatch": handler("preview.unwatch"),
  };
}
