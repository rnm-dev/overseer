import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir } from "../runtime/xdgPaths.js";
import { ensureProjectDocs, migrateProjectMetadata } from "./docs.js";
const STATE_PATH = path.join(configDir(), "projects.json");
export const PROJECTS_ROOT = path.join(os.homedir(), "Projects");
export const MAX_PROJECT_CATALOG_EVENTS = 5_000;
export function slugify(name) {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}
// The project import flow prefills its dir field with this — same
// convention createProject() falls back to when no dir is given explicitly.
export function suggestDir(label) {
    return path.join(PROJECTS_ROOT, slugify(label));
}
function nonEmpty(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}
/** Merge legacy context fields losslessly before moving them into docs/. */
export function mergeLegacyProjectMetadata(record) {
    const sections = [];
    const metadata = nonEmpty(record.metadata);
    const info = nonEmpty(record.info);
    const setup = nonEmpty(record.setup);
    const publication = nonEmpty(record.publication);
    const publicationError = nonEmpty(record.publicationError);
    const routes = Array.isArray(record.publicationRoutes) ? record.publicationRoutes : [];
    const publicationStatus = nonEmpty(record.publicationStatus);
    if (metadata)
        sections.push(metadata);
    if (info)
        sections.push(`## Project information\n\n${info}`);
    if (setup)
        sections.push(`## Local setup\n\n${setup}`);
    const publicationParts = [];
    if (publication)
        publicationParts.push(publication);
    if (publicationStatus && publicationStatus !== "unpublished") {
        publicationParts.push(`**Status:** ${publicationStatus}`);
    }
    if (publicationError)
        publicationParts.push(`**Last error:** ${publicationError}`);
    if (routes.length > 0) {
        publicationParts.push(`### Routes\n\n\`\`\`json\n${JSON.stringify(routes, null, 2)}\n\`\`\``);
    }
    if (publicationParts.length > 0)
        sections.push(`## Publication\n\n${publicationParts.join("\n\n")}`);
    return sections.length > 0 ? sections.join("\n\n") : null;
}
function initialCatalog() {
    return { epoch: randomUUID(), revision: 0, seq: 0, acknowledgedSeq: 0, events: [] };
}
function writeState(statePath, state) {
    const directory = path.dirname(statePath);
    mkdirSync(directory, { recursive: true });
    const temporary = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600, flag: "wx" });
        const descriptor = openSync(temporary, constants.O_RDWR);
        try {
            fsyncSync(descriptor);
        }
        finally {
            closeSync(descriptor);
        }
        renameSync(temporary, statePath);
        if (process.platform !== "win32") {
            const directoryDescriptor = openSync(directory, constants.O_RDONLY);
            try {
                fsyncSync(directoryDescriptor);
            }
            finally {
                closeSync(directoryDescriptor);
            }
        }
    }
    finally {
        rmSync(temporary, { force: true });
    }
}
function read(statePath) {
    if (!existsSync(statePath))
        return { projects: {}, projectCatalog: initialCatalog() };
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    let migrated = false;
    if (!state.projectCatalog) {
        state.projectCatalog = initialCatalog();
        migrated = true;
    }
    for (const [key, stored] of Object.entries(state.projects)) {
        const metadata = mergeLegacyProjectMetadata(stored);
        const { metadata: _metadata, integrationKey, integrationProjectKey, info, setup, publication, publicationStatus, publicationRoutes, publicationError, ...record } = stored;
        const normalized = {
            ...record,
            projectId: nonEmpty(record.projectId) ?? randomUUID(),
            quickLinks: Array.isArray(record.quickLinks) ? record.quickLinks : [],
            archivedAt: typeof record.archivedAt === "number" && Number.isSafeInteger(record.archivedAt)
                ? record.archivedAt
                : null,
        };
        if (metadata)
            migrateProjectMetadata(normalized.dir, normalized.label, metadata);
        else
            ensureProjectDocs(normalized.dir, normalized.label);
        if (JSON.stringify(stored) !== JSON.stringify(normalized))
            migrated = true;
        state.projects[key] = normalized;
    }
    for (const event of state.projectCatalog.events) {
        const legacyEvent = event;
        if (legacyEvent.project && legacyEvent.project.archivedAt === undefined) {
            legacyEvent.project.archivedAt = null;
            migrated = true;
        }
    }
    if (migrated) {
        writeState(statePath, state);
    }
    return state;
}
export class ProjectStore extends EventEmitter {
    statePath;
    state;
    constructor(statePath = STATE_PATH) {
        super();
        this.statePath = statePath;
        this.state = read(statePath);
    }
    persist(state) {
        writeState(this.statePath, state);
    }
    list() {
        return Object.values(this.state.projects);
    }
    get(key) {
        return this.state.projects[key];
    }
    getById(projectId) {
        return Object.values(this.state.projects).find((project) => project.projectId === projectId);
    }
    catalogState() {
        const catalog = this.state.projectCatalog;
        return {
            epoch: catalog.epoch,
            revision: catalog.revision,
            earliestSeq: catalog.events[0]?.seq ?? catalog.seq + 1,
            latestSeq: catalog.seq,
        };
    }
    catalogEventsAfter(seq) {
        const catalog = this.state.projectCatalog;
        if (!Number.isSafeInteger(seq) || seq < catalog.acknowledgedSeq || seq > catalog.seq)
            return null;
        const earliest = catalog.events[0]?.seq ?? catalog.seq + 1;
        if (seq < earliest - 1)
            return null;
        return catalog.events.filter((event) => event.seq > seq).map((event) => structuredClone(event));
    }
    acknowledgeProjectCatalog(seq) {
        const current = this.state.projectCatalog;
        if (!Number.isSafeInteger(seq) || seq < current.acknowledgedSeq || seq > current.seq)
            return false;
        if (seq === current.acknowledgedSeq)
            return true;
        const next = structuredClone(this.state);
        next.projectCatalog.acknowledgedSeq = seq;
        next.projectCatalog.events = next.projectCatalog.events.filter((event) => event.seq > seq);
        this.persist(next);
        this.state = next;
        return true;
    }
    update(key, patch) {
        const current = this.state.projects[key];
        if (!current)
            throw new Error(`unknown project: ${key}`);
        const nextKey = patch.key ?? key;
        if (nextKey !== key && this.state.projects[nextKey]) {
            throw new Error(`project already exists: ${nextKey}`);
        }
        // Point a project at a different dir and ensure it exists, same as insert()
        // does on import/create — a session runs in this dir, so it can't dangle.
        // (The old dir is left untouched; this is a re-point, not a move.) Unlike
        // insert(), no docs are written: an existing directory belongs to the
        // operator, and a docs read already tolerates a project without them.
        if (patch.dir && patch.dir !== current.dir) {
            mkdirSync(patch.dir, { recursive: true });
        }
        // Re-assert the immutable identity at runtime as well as in the patch type,
        // so an untyped/internal caller can never mutate it accidentally.
        const updated = { ...current, ...patch, projectId: current.projectId, lastSyncedAt: Date.now() };
        const next = structuredClone(this.state);
        if (next.projectCatalog.events.length >= MAX_PROJECT_CATALOG_EVENTS) {
            throw new Error("project catalog journal is full; waiting for Overseer acknowledgement");
        }
        if (nextKey !== key)
            delete next.projects[key];
        next.projects[nextKey] = updated;
        const event = this.appendCatalogEvent(next, { project: catalogProject(updated) });
        this.persist(next);
        this.state = next;
        if (nextKey !== key)
            this.emit("rename", { oldKey: key, record: updated });
        this.emit("change", updated);
        this.emit("catalog", event);
        return updated;
    }
    // Throws on a key collision rather than upserting — re-creating isn't a supported
    // way to refresh a record; use update() for that.
    insert(record, initialMetadata) {
        if (this.state.projects[record.key]) {
            throw new Error(`project already exists: ${record.key}`);
        }
        mkdirSync(record.dir, { recursive: true });
        if (initialMetadata?.trim()) {
            migrateProjectMetadata(record.dir, record.label, initialMetadata);
        }
        else {
            ensureProjectDocs(record.dir, record.label);
        }
        if (this.state.projectCatalog.events.length >= MAX_PROJECT_CATALOG_EVENTS) {
            throw new Error("project catalog journal is full; waiting for Overseer acknowledgement");
        }
        const stored = record;
        const next = structuredClone(this.state);
        next.projects[record.key] = stored;
        const event = this.appendCatalogEvent(next, { project: catalogProject(stored) });
        this.persist(next);
        this.state = next;
        this.emit("change", stored);
        this.emit("catalog", event);
        return stored;
    }
    createProject(fields) {
        const { metadata, ...recordFields } = fields;
        return this.insert({ ...recordFields, projectId: randomUUID(), quickLinks: [], archivedAt: null, lastSyncedAt: Date.now() }, metadata);
    }
    // No cascade: sessions keep whatever projectKey they already recorded —
    // this is bookkeeping cleanup, not a data-integrity concern for
    // already-persisted history.
    remove(key) {
        const record = this.state.projects[key];
        if (!record)
            return;
        if (this.state.projectCatalog.events.length >= MAX_PROJECT_CATALOG_EVENTS) {
            throw new Error("project catalog journal is full; waiting for Overseer acknowledgement");
        }
        const next = structuredClone(this.state);
        delete next.projects[key];
        const event = this.appendCatalogEvent(next, { deletedProjectId: record.projectId });
        this.persist(next);
        this.state = next;
        this.emit("remove", key);
        this.emit("catalog", event);
    }
    appendCatalogEvent(state, value) {
        state.projectCatalog.seq += 1;
        state.projectCatalog.revision += 1;
        const event = {
            seq: state.projectCatalog.seq,
            revision: state.projectCatalog.revision,
            ...value,
        };
        state.projectCatalog.events.push(event);
        return event;
    }
}
export function catalogProject(record) {
    return {
        projectId: record.projectId,
        key: record.key,
        label: record.label,
        dir: record.dir,
        quickLinks: structuredClone(record.quickLinks),
        archivedAt: record.archivedAt,
    };
}
export const projectStore = new ProjectStore();
