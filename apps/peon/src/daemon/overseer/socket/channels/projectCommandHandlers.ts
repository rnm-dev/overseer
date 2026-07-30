import {
  createProjectService,
  projectStore,
  ProjectDocsError,
  type ProjectService,
  ProjectServiceError,
} from "../../../projects/index.js";
import { sessions } from "../../../sessions/index.js";
import type {
  ReverseCommandExecution,
  ReverseCommandHandler,
  ValidCommand,
} from "./reverseCommandChannel.js";
import type { PeonSocketFrame } from "../peonSocketProtocol.js";

const service = createProjectService(projectStore, {
  list: () => sessions.list(),
  renameProjectKey: (oldKey, newKey) => sessions.renameProjectKey(oldKey, newKey),
  start: (options) => sessions.start(options),
  rename: (id, title) => sessions.rename(id, title),
});

function strict(value: PeonSocketFrame, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function failure(error: unknown): ReverseCommandExecution {
  if (error instanceof ProjectServiceError) {
    return {
      status: ["PROJECT_CONFLICT", "PROJECT_EXISTS", "PROJECT_RUNNING"].includes(error.kind) ? "conflict" : "rejected",
      code: error.kind,
    };
  }
  if (error instanceof ProjectDocsError) {
    return error.code === "INTERNAL"
      ? { status: "failed", code: "INTERNAL" }
      : { status: "rejected", code: error.code };
  }
  return { status: "failed", code: "INTERNAL" };
}

function bounded(result: PeonSocketFrame): ReverseCommandExecution {
  return Buffer.byteLength(JSON.stringify(result)) <= 48 * 1024
    ? { status: "applied", code: "OK", result }
    : { status: "rejected", code: "RESULT_TOO_LARGE" };
}

function integerInRange(value: unknown, minimum: number, maximum: number): boolean {
  return value === undefined || (Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum);
}

function sliceUtf8(content: string, offset: number, limit: number): {
  content: string;
  offset: number;
  nextOffset: number | null;
} {
  const bytes = Buffer.from(content);
  let start = Math.min(offset, bytes.length);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start += 1;
  let end = Math.min(start + limit, bytes.length);
  while (end > start && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return {
    content: bytes.subarray(start, end).toString("utf8"),
    offset: start,
    nextOffset: end < bytes.length ? end : null,
  };
}

function define(
  validate: ReverseCommandHandler["validate"],
  execute: (command: ValidCommand) => PeonSocketFrame,
  options: { projectTarget?: boolean } = {},
): ReverseCommandHandler {
  return {
    maxConcurrency: 4,
    validate(payload, expected, command) {
      if (options.projectTarget && !command.target.projectId) {
        return "operation requires target.projectId";
      }
      return validate(payload, expected, command);
    },
    execute(command) {
      try {
        return bounded(execute(command));
      } catch (error) {
        return failure(error);
      }
    },
  };
}

const empty: ReverseCommandHandler["validate"] = (payload, expected) =>
  strict(payload, []) && expected === null ? null : "operation requires an empty payload and no expected state";
const id = (command: ValidCommand) => command.target.projectId!;
const digest = (expected: PeonSocketFrame | null) =>
  expected && strict(expected, ["digest"]) && typeof expected.digest === "string"
    && /^[0-9a-f]{64}$/.test(expected.digest) ? expected.digest : null;

export function projectCommandHandlers(projectService: ProjectService = service): Record<string, ReverseCommandHandler> {
  return {
    "project.create": define(
      (payload, expected) => strict(payload, ["label", "dir"]) && typeof payload.label === "string"
        && (payload.dir === undefined || typeof payload.dir === "string") && expected === null ? null : "invalid project create",
      (command) => projectService.createRevisioned(command.payload, command.actor.email) as unknown as PeonSocketFrame,
    ),
    "project.suggest-directory": define(
      (payload, expected) => strict(payload, ["label"]) && typeof payload.label === "string" && expected === null ? null : "invalid directory suggestion",
      (command) => projectService.suggest(command.payload.label) as PeonSocketFrame,
    ),
    "project.detail": define(empty, (command) => projectService.detailById(id(command)) as unknown as PeonSocketFrame, { projectTarget: true }),
    "project.settings.get": define(empty, (command) => projectService.settingsById(id(command)) as unknown as PeonSocketFrame, { projectTarget: true }),
    "project.settings.update": define(
      (payload, expected) => strict(payload, ["key", "name", "dir"]) && Object.keys(payload).length > 0 && digest(expected) ? null : "invalid project update",
      (command) => projectService.updateSettingsById(id(command), command.payload, digest(command.expected)!) as unknown as PeonSocketFrame,
      { projectTarget: true },
    ),
    "project.delete": define(
      (payload, expected) => strict(payload, []) && digest(expected) ? null : "invalid project delete",
      (command) => projectService.removeById(id(command), digest(command.expected)!) as unknown as PeonSocketFrame,
      { projectTarget: true },
    ),
    "project.documentation.index": define(empty, (command) => projectService.documentationById(id(command)) as unknown as PeonSocketFrame, { projectTarget: true }),
    "project.documentation.read": define(
      (payload, expected) => strict(payload, ["path", "offset", "limit"]) && typeof payload.path === "string"
        && integerInRange(payload.offset, 0, Number.MAX_SAFE_INTEGER)
        && integerInRange(payload.limit, 1, 32 * 1024) && expected === null ? null : "invalid documentation read",
      (command) => {
        const page = projectService.documentById(id(command), command.payload.path as string);
        return {
          ...page,
          ...sliceUtf8(
            page.content,
            Number(command.payload.offset ?? 0),
            Number(command.payload.limit ?? 32 * 1024),
          ),
        };
      },
      { projectTarget: true },
    ),
    "project.skills.list": define(empty, (command) => projectService.skillsById(id(command)) as unknown as PeonSocketFrame, { projectTarget: true }),
    "project.quick-links.list": define(empty, (command) => projectService.listQuickLinksById(id(command)) as unknown as PeonSocketFrame, { projectTarget: true }),
    "project.quick-links.create": define(
      (payload, expected) => strict(payload, ["title", "url"]) && digest(expected) ? null : "invalid quick link create",
      (command) => projectService.createQuickLinkById(id(command), command.payload, digest(command.expected)!) as unknown as PeonSocketFrame,
      { projectTarget: true },
    ),
    "project.quick-links.update": define(
      (payload, expected) => strict(payload, ["id", "title", "url"]) && typeof payload.id === "string" && digest(expected) ? null : "invalid quick link update",
      (command) => projectService.updateQuickLinkById(id(command), command.payload.id as string, command.payload, digest(command.expected)!) as unknown as PeonSocketFrame,
      { projectTarget: true },
    ),
    "project.quick-links.delete": define(
      (payload, expected) => strict(payload, ["id"]) && typeof payload.id === "string" && digest(expected) ? null : "invalid quick link delete",
      (command) => projectService.removeQuickLinkById(id(command), command.payload.id as string, digest(command.expected)!) as unknown as PeonSocketFrame,
      { projectTarget: true },
    ),
  };
}
