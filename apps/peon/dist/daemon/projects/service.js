import { randomUUID } from "node:crypto";
import path from "node:path";
import { projectDocumentation, readProjectDoc } from "./docs.js";
import { listProjectSkills } from "./skills.js";
import { slugify, suggestDir, } from "./state.js";
export const MAX_PROJECT_QUICK_LINKS = 100;
export const MAX_PROJECT_QUICK_LINK_TITLE_LENGTH = 120;
export const MAX_PROJECT_QUICK_LINK_URL_LENGTH = 2_048;
export const MAX_PROJECT_QUICK_LINKS_BYTES = 32 * 1024;
export class ProjectServiceError extends Error {
    status;
    kind;
    constructor(status, kind, message) {
        super(message);
        this.status = status;
        this.kind = kind;
    }
}
export const PROJECT_ONBOARDING_PROMPT = `Help the user create lightweight baseline documentation for this project.

For this first turn:
1. Inspect the project folder read-only so you do not ask questions the repository already answers.
2. Do not edit any files yet.
3. Ask the user 3–5 concise, high-value questions in one message. Cover only what is useful and still unclear, such as the project's purpose and users, current stage, important workflows or commands, and non-obvious constraints. Make it easy to answer briefly, and allow “not sure” where appropriate.
4. Stop after the questions and wait for the user's follow-up.

After the user answers, create or update docs/index.md as a concise project hub. Add focused documents under docs/ only when the project genuinely needs them. Capture useful commands, workflows, architecture, and constraints that are supported by the repository or the user's answers. Keep it practical and lightweight; do not manufacture process or excessive documentation.`;
export class ProjectService {
    projects;
    sessionIndex;
    constructor(projects, sessionIndex) {
        this.projects = projects;
        this.sessionIndex = sessionIndex;
    }
    list() {
        return this.projects.list().map((record) => this.toListView(record));
    }
    detail(key) {
        const record = this.requireProject(key);
        return { ...this.toListView(record), documentation: projectDocumentation(record.dir) };
    }
    documentation(key) {
        return projectDocumentation(this.requireProject(key).dir);
    }
    document(key, docPath) {
        return readProjectDoc(this.requireProject(key).dir, docPath);
    }
    skills(key) {
        return { skills: listProjectSkills(this.requireProject(key).dir) };
    }
    listQuickLinks(key) {
        return { links: structuredClone(this.requireProject(key).quickLinks) };
    }
    createQuickLink(key, input) {
        const record = this.requireProject(key);
        if (record.quickLinks.length >= MAX_PROJECT_QUICK_LINKS) {
            throw new ProjectServiceError(400, "BAD_REQUEST", `a project may have at most ${MAX_PROJECT_QUICK_LINKS} quick links`);
        }
        const body = this.body(input);
        const link = {
            id: randomUUID(),
            title: this.quickLinkTitle(body.title),
            url: this.quickLinkUrl(body.url),
            order: record.quickLinks.reduce((maximum, item) => Math.max(maximum, item.order), -1) + 1,
        };
        const quickLinks = [...record.quickLinks, link];
        this.validateQuickLinksSize(quickLinks);
        this.projects.update(key, { quickLinks });
        return structuredClone(link);
    }
    updateQuickLink(key, id, input) {
        const record = this.requireProject(key);
        const index = record.quickLinks.findIndex((link) => link.id === id);
        if (index < 0)
            throw new ProjectServiceError(404, "UNKNOWN_QUICK_LINK", "unknown project quick link");
        const body = this.body(input);
        if (!("title" in body) && !("url" in body)) {
            throw new ProjectServiceError(400, "BAD_REQUEST", "at least one of title or url is required");
        }
        const current = record.quickLinks[index];
        const updated = {
            ...current,
            ...("title" in body ? { title: this.quickLinkTitle(body.title) } : {}),
            ...("url" in body ? { url: this.quickLinkUrl(body.url) } : {}),
        };
        const quickLinks = [...record.quickLinks];
        quickLinks[index] = updated;
        this.validateQuickLinksSize(quickLinks);
        this.projects.update(key, { quickLinks });
        return structuredClone(updated);
    }
    removeQuickLink(key, id) {
        const record = this.requireProject(key);
        const quickLinks = record.quickLinks.filter((link) => link.id !== id);
        if (quickLinks.length === record.quickLinks.length) {
            throw new ProjectServiceError(404, "UNKNOWN_QUICK_LINK", "unknown project quick link");
        }
        this.projects.update(key, { quickLinks });
    }
    settings(key) {
        return this.toSettingsView(this.requireProject(key));
    }
    suggest(labelInput) {
        const label = typeof labelInput === "string" ? labelInput.trim() : "";
        if (!label)
            throw new ProjectServiceError(400, "BAD_REQUEST", "label query param is required");
        const key = slugify(label);
        if (!key) {
            throw new ProjectServiceError(400, "BAD_REQUEST", "label must contain at least one letter or number");
        }
        return { key, dir: suggestDir(label) };
    }
    create(input, author) {
        const body = this.body(input);
        const label = typeof body.label === "string" ? body.label.trim() : "";
        if (!label)
            throw new ProjectServiceError(400, "BAD_REQUEST", "label is required");
        const key = slugify(label);
        if (!key) {
            throw new ProjectServiceError(400, "BAD_REQUEST", "label must contain at least one letter or number");
        }
        if (this.projects.get(key)) {
            throw new ProjectServiceError(409, "PROJECT_EXISTS", `a project named "${label}" already exists`);
        }
        const dir = typeof body.dir === "string" && body.dir.trim() ? body.dir.trim() : suggestDir(label);
        const project = this.projects.createProject({ key, label, dir });
        let onboardingSessionId = null;
        try {
            const onboarding = this.sessionIndex.start({
                prompt: PROJECT_ONBOARDING_PROMPT,
                dir: project.dir,
                projectKey: project.key,
                author,
            });
            onboardingSessionId = onboarding.id;
            this.sessionIndex.rename(onboarding.id, "Set up project documentation");
        }
        catch {
            // Project creation is the primary operation. A temporarily unavailable
            // agent must not roll it back or turn a successful create into a 500.
        }
        return { ...project, onboardingSessionId };
    }
    updateSettings(key, input) {
        const record = this.requireProject(key);
        const body = this.body(input);
        const patch = {};
        if ("key" in body) {
            const nextKey = typeof body.key === "string" ? body.key.trim() : "";
            if (!nextKey || slugify(nextKey) !== nextKey) {
                throw new ProjectServiceError(400, "BAD_REQUEST", "key must contain only lowercase letters, numbers, and single hyphens");
            }
            if (nextKey !== record.key && this.projects.get(nextKey)) {
                throw new ProjectServiceError(409, "PROJECT_EXISTS", `project key "${nextKey}" already exists`);
            }
            patch.key = nextKey;
        }
        if ("name" in body) {
            const name = typeof body.name === "string" ? body.name.trim() : "";
            if (!name)
                throw new ProjectServiceError(400, "BAD_REQUEST", "name must be a non-empty string");
            patch.label = name;
        }
        if ("dir" in body) {
            const dir = typeof body.dir === "string" ? body.dir.trim() : "";
            if (!dir || !path.isAbsolute(dir)) {
                throw new ProjectServiceError(400, "BAD_REQUEST", "dir must be a non-empty absolute path");
            }
            patch.dir = dir;
        }
        if (Object.keys(patch).length === 0) {
            throw new ProjectServiceError(400, "BAD_REQUEST", "at least one of key, name, or dir is required");
        }
        const updated = this.projects.update(record.key, patch);
        if (updated.key !== record.key)
            this.sessionIndex.renameProjectKey(record.key, updated.key);
        return this.toSettingsView(updated);
    }
    remove(key) {
        this.requireProject(key);
        if (this.sessionIndex.list().some((session) => session.status === "running" && session.projectKey === key)) {
            throw new ProjectServiceError(409, "PROJECT_RUNNING", "a session is currently running against this project");
        }
        this.projects.remove(key);
    }
    archive(key) {
        return this.setArchived(this.requireProject(key), true);
    }
    unarchive(key) {
        return this.setArchived(this.requireProject(key), false);
    }
    archiveById(projectId) {
        const record = this.requireProjectId(projectId);
        const changed = record.archivedAt === null;
        return { project: this.setArchived(record, true), changed };
    }
    unarchiveById(projectId) {
        const record = this.requireProjectId(projectId);
        const changed = record.archivedAt !== null;
        return { project: this.setArchived(record, false), changed };
    }
    requireProject(key) {
        const record = this.projects.get(key);
        if (!record)
            throw new ProjectServiceError(404, "UNKNOWN_PROJECT", "unknown project");
        return record;
    }
    requireProjectId(projectId) {
        const record = this.projects.getById(projectId);
        if (!record)
            throw new ProjectServiceError(404, "UNKNOWN_PROJECT", "unknown project");
        return record;
    }
    setArchived(record, archived) {
        if ((record.archivedAt !== null) === archived)
            return this.toListView(record);
        return this.toListView(this.projects.update(record.key, { archivedAt: archived ? Date.now() : null }));
    }
    body(input) {
        return typeof input === "object" && input !== null ? input : {};
    }
    toListView(record) {
        return {
            projectId: record.projectId,
            key: record.key,
            label: record.label,
            dir: record.dir,
            quickLinks: structuredClone(record.quickLinks),
            archivedAt: record.archivedAt,
            lastSyncedAt: record.lastSyncedAt,
        };
    }
    toSettingsView(record) {
        return { projectId: record.projectId, key: record.key, name: record.label, dir: record.dir };
    }
    quickLinkTitle(value) {
        const title = typeof value === "string" ? value.trim() : "";
        if (!title || title.length > MAX_PROJECT_QUICK_LINK_TITLE_LENGTH || /[\0-\x1f\x7f]/.test(title)) {
            throw new ProjectServiceError(400, "BAD_REQUEST", `title must be 1-${MAX_PROJECT_QUICK_LINK_TITLE_LENGTH} characters without control characters`);
        }
        return title;
    }
    quickLinkUrl(value) {
        const raw = typeof value === "string" ? value.trim() : "";
        if (!raw || raw.length > MAX_PROJECT_QUICK_LINK_URL_LENGTH) {
            throw new ProjectServiceError(400, "BAD_REQUEST", `url must be 1-${MAX_PROJECT_QUICK_LINK_URL_LENGTH} characters`);
        }
        let parsed;
        try {
            parsed = new URL(raw);
        }
        catch {
            throw new ProjectServiceError(400, "BAD_REQUEST", "url must be an absolute HTTP or HTTPS URL");
        }
        if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
            throw new ProjectServiceError(400, "BAD_REQUEST", "url must be an absolute HTTP or HTTPS URL without credentials");
        }
        return parsed.href;
    }
    validateQuickLinksSize(links) {
        if (Buffer.byteLength(JSON.stringify(links)) > MAX_PROJECT_QUICK_LINKS_BYTES) {
            throw new ProjectServiceError(400, "BAD_REQUEST", "project quick links exceed the 32 KiB synchronization limit");
        }
    }
}
export function createProjectService(projectStore, sessionIndex) {
    return new ProjectService(projectStore, sessionIndex);
}
