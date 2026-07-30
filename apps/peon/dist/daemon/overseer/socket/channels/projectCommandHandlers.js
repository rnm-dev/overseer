import { createHash } from "node:crypto";
import { createProjectService, projectStore, ProjectDocsError, ProjectServiceError, } from "../../../projects/index.js";
import { sessions } from "../../../sessions/index.js";
const service = createProjectService(projectStore, {
    list: () => sessions.list(),
    renameProjectKey: (oldKey, newKey) => sessions.renameProjectKey(oldKey, newKey),
    start: (options) => sessions.start(options),
    rename: (id, title) => sessions.rename(id, title),
});
const DOCUMENTATION_INDEX_MAX_BYTES = 2 * 1024 * 1024;
const DOCUMENTATION_INDEX_DEFAULT_PAGE_BYTES = 24 * 1024;
class ProjectCommandError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
    }
}
function strict(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
}
function failure(error) {
    if (error instanceof ProjectCommandError) {
        return { status: error.code === "CURSOR_EXPIRED" ? "conflict" : "rejected", code: error.code };
    }
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
function documentationCursor(digest, offset) {
    const checksum = createHash("sha256")
        .update(`project-doc-index-v1\0${digest}\0${offset}`)
        .digest("hex");
    return Buffer.from(JSON.stringify({ v: 1, d: digest, o: offset, c: checksum })).toString("base64url");
}
function parseDocumentationCursor(value) {
    if (typeof value !== "string" || value.length < 1 || value.length > 512)
        return null;
    try {
        const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
        if (!strict(decoded, ["v", "d", "o", "c"]) || decoded.v !== 1
            || typeof decoded.d !== "string" || !/^[0-9a-f]{64}$/.test(decoded.d)
            || !Number.isSafeInteger(decoded.o) || Number(decoded.o) < 0
            || typeof decoded.c !== "string" || !/^[0-9a-f]{64}$/.test(decoded.c))
            return null;
        const expected = createHash("sha256")
            .update(`project-doc-index-v1\0${decoded.d}\0${decoded.o}`)
            .digest("hex");
        return expected === decoded.c ? { digest: decoded.d, offset: Number(decoded.o) } : null;
    }
    catch {
        return null;
    }
}
function bounded(result) {
    return Buffer.byteLength(JSON.stringify(result)) <= 48 * 1024
        ? { status: "applied", code: "OK", result }
        : { status: "rejected", code: "RESULT_TOO_LARGE" };
}
function integerInRange(value, minimum, maximum) {
    return value === undefined || (Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum);
}
function sliceUtf8(content, offset, limit) {
    const bytes = Buffer.from(content);
    let start = Math.min(offset, bytes.length);
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80)
        start += 1;
    let end = Math.min(start + limit, bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80)
        end -= 1;
    return {
        content: bytes.subarray(start, end).toString("utf8"),
        offset: start,
        nextOffset: end < bytes.length ? end : null,
    };
}
function define(validate, execute, options = {}) {
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
            }
            catch (error) {
                return failure(error);
            }
        },
    };
}
const empty = (payload, expected) => strict(payload, []) && expected === null ? null : "operation requires an empty payload and no expected state";
const id = (command) => command.target.projectId;
const digest = (expected) => expected && strict(expected, ["digest"]) && typeof expected.digest === "string"
    && /^[0-9a-f]{64}$/.test(expected.digest) ? expected.digest : null;
function archiveHandler(projectService, archived) {
    return {
        maxConcurrency: 4,
        validate(payload, expected, command) {
            if (!command.target.projectId)
                return "operation requires target.projectId";
            return empty(payload, expected, command);
        },
        execute(command) {
            try {
                const projectId = id(command);
                const outcome = archived
                    ? projectService.archiveById(projectId)
                    : projectService.unarchiveById(projectId);
                return {
                    status: outcome.changed ? "applied" : "noop",
                    code: "OK",
                    result: {
                        projectId,
                        key: outcome.project.key,
                        archivedAt: outcome.project.archivedAt,
                    },
                };
            }
            catch (error) {
                return failure(error);
            }
        },
    };
}
export function projectCommandHandlers(projectService = service) {
    return {
        "project.create": define((payload, expected) => strict(payload, ["label", "dir"]) && typeof payload.label === "string"
            && (payload.dir === undefined || typeof payload.dir === "string") && expected === null ? null : "invalid project create", (command) => projectService.createRevisioned(command.payload, command.actor.email)),
        "project.suggest-directory": define((payload, expected) => strict(payload, ["label"]) && typeof payload.label === "string" && expected === null ? null : "invalid directory suggestion", (command) => projectService.suggest(command.payload.label)),
        "project.detail": define(empty, (command) => projectService.detailById(id(command)), { projectTarget: true }),
        "project.settings.get": define(empty, (command) => projectService.settingsById(id(command)), { projectTarget: true }),
        "project.settings.update": define((payload, expected) => strict(payload, ["key", "name", "dir"]) && Object.keys(payload).length > 0 && digest(expected) ? null : "invalid project update", (command) => projectService.updateSettingsById(id(command), command.payload, digest(command.expected)), { projectTarget: true }),
        "project.delete": define((payload, expected) => strict(payload, []) && digest(expected) ? null : "invalid project delete", (command) => projectService.removeById(id(command), digest(command.expected)), { projectTarget: true }),
        "project.archive": archiveHandler(projectService, true),
        "project.unarchive": archiveHandler(projectService, false),
        "project.documentation.index": define((payload, expected) => strict(payload, ["cursor", "limit"])
            && (payload.cursor === undefined || typeof payload.cursor === "string")
            && integerInRange(payload.limit, 1, 32 * 1024)
            && expected === null ? null : "invalid documentation index request", (command) => {
            const serialized = JSON.stringify(projectService.documentationById(id(command)));
            const totalBytes = Buffer.byteLength(serialized);
            if (totalBytes > DOCUMENTATION_INDEX_MAX_BYTES)
                throw new ProjectCommandError("RESULT_TOO_LARGE");
            const snapshotDigest = createHash("sha256").update(serialized).digest("hex");
            const cursor = command.payload.cursor === undefined
                ? { digest: snapshotDigest, offset: 0 }
                : parseDocumentationCursor(command.payload.cursor);
            if (!cursor)
                throw new ProjectCommandError("INVALID_CURSOR");
            if (cursor.digest !== snapshotDigest || cursor.offset > totalBytes) {
                throw new ProjectCommandError("CURSOR_EXPIRED");
            }
            const page = sliceUtf8(serialized, cursor.offset, Number(command.payload.limit ?? DOCUMENTATION_INDEX_DEFAULT_PAGE_BYTES));
            return {
                snapshotDigest,
                byteOffset: page.offset,
                totalBytes,
                chunk: page.content,
                cursor: documentationCursor(snapshotDigest, page.offset),
                nextCursor: page.nextOffset === null ? null : documentationCursor(snapshotDigest, page.nextOffset),
            };
        }, { projectTarget: true }),
        "project.documentation.read": define((payload, expected) => strict(payload, ["path", "offset", "limit"]) && typeof payload.path === "string"
            && integerInRange(payload.offset, 0, Number.MAX_SAFE_INTEGER)
            && integerInRange(payload.limit, 1, 32 * 1024) && expected === null ? null : "invalid documentation read", (command) => {
            const page = projectService.documentById(id(command), command.payload.path);
            return {
                ...page,
                ...sliceUtf8(page.content, Number(command.payload.offset ?? 0), Number(command.payload.limit ?? 32 * 1024)),
            };
        }, { projectTarget: true }),
        "project.skills.list": define(empty, (command) => projectService.skillsById(id(command)), { projectTarget: true }),
        "project.quick-links.list": define(empty, (command) => projectService.listQuickLinksById(id(command)), { projectTarget: true }),
        "project.quick-links.create": define((payload, expected) => strict(payload, ["title", "url"]) && digest(expected) ? null : "invalid quick link create", (command) => projectService.createQuickLinkById(id(command), command.payload, digest(command.expected)), { projectTarget: true }),
        "project.quick-links.update": define((payload, expected) => strict(payload, ["id", "title", "url"]) && typeof payload.id === "string" && digest(expected) ? null : "invalid quick link update", (command) => projectService.updateQuickLinkById(id(command), command.payload.id, command.payload, digest(command.expected)), { projectTarget: true }),
        "project.quick-links.delete": define((payload, expected) => strict(payload, ["id"]) && typeof payload.id === "string" && digest(expected) ? null : "invalid quick link delete", (command) => projectService.removeQuickLinkById(id(command), command.payload.id, digest(command.expected)), { projectTarget: true }),
    };
}
