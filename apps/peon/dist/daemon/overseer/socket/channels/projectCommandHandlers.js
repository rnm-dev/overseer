import { createProjectService, projectStore, ProjectDocsError, ProjectServiceError, } from "../../../projects/index.js";
import { sessions } from "../../../sessions/index.js";
const service = createProjectService(projectStore, {
    list: () => sessions.list(),
    renameProjectKey: (oldKey, newKey) => sessions.renameProjectKey(oldKey, newKey),
    start: (options) => sessions.start(options),
    rename: (id, title) => sessions.rename(id, title),
});
function strict(value, keys) {
    return Object.keys(value).every((key) => keys.includes(key));
}
function failure(error) {
    if (error instanceof ProjectServiceError) {
        return {
            status: ["PROJECT_CONFLICT", "PROJECT_EXISTS", "PROJECT_RUNNING"].includes(error.kind) ? "conflict" : "rejected",
            code: error.kind,
        };
    }
    if (error instanceof ProjectDocsError)
        return { status: "rejected", code: error.code };
    return { status: "failed", code: "INTERNAL" };
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
    const start = Math.min(offset, bytes.length);
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
const digest = (expected) => expected && strict(expected, ["digest"]) && typeof expected.digest === "string" ? expected.digest : null;
export function projectCommandHandlers(projectService = service) {
    return {
        "project.create": define((payload, expected) => strict(payload, ["label", "dir"]) && typeof payload.label === "string"
            && (payload.dir === undefined || typeof payload.dir === "string") && expected === null ? null : "invalid project create", (command) => projectService.createRevisioned(command.payload, command.actor.email)),
        "project.suggest-directory": define((payload, expected) => strict(payload, ["label"]) && typeof payload.label === "string" && expected === null ? null : "invalid directory suggestion", (command) => projectService.suggest(command.payload.label)),
        "project.detail": define(empty, (command) => projectService.detailById(id(command)), { projectTarget: true }),
        "project.settings.get": define(empty, (command) => projectService.settingsById(id(command)), { projectTarget: true }),
        "project.settings.update": define((payload, expected) => strict(payload, ["key", "name", "dir"]) && Object.keys(payload).length > 0 && digest(expected) ? null : "invalid project update", (command) => projectService.updateSettingsById(id(command), command.payload, digest(command.expected)), { projectTarget: true }),
        "project.delete": define((payload, expected) => strict(payload, []) && digest(expected) ? null : "invalid project delete", (command) => projectService.removeById(id(command), digest(command.expected)), { projectTarget: true }),
        "project.documentation.index": define(empty, (command) => projectService.documentationById(id(command)), { projectTarget: true }),
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
