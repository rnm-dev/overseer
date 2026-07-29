import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectStore } from "../../../projects/index.js";
export const FOLDER_LISTING_CAPABILITY = "folder-listing-v1";
export const FOLDER_LISTING_MAX_PAGE_BYTES = 900 * 1024;
export const FOLDER_LISTING_MAX_ENTRIES = 20_000;
export const FOLDER_LISTING_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_LEASE_MS = 30_000;
const MAX_REQUEST_ID_LENGTH = 200;
const MAX_SELECTOR_LENGTH = 4096;
const SYMLINK_STAT_CONCURRENCY = 64;
const FRAME_TYPES = new Set(["folder_list_request", "folder_list_cancel"]);
class FolderListingError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
function stringField(frame, key, maxLength = MAX_SELECTOR_LENGTH) {
    const value = frame[key];
    return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}
function requestedLimit(value) {
    if (value === undefined)
        return DEFAULT_LIMIT;
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new FolderListingError("BAD_REQUEST", "limit must be a positive integer");
    }
    return Math.min(value, MAX_LIMIT);
}
function filesystemError(error) {
    const code = error.code;
    if (code === "EACCES" || code === "EPERM")
        return new FolderListingError("FORBIDDEN", "filesystem path is not readable");
    if (code === "ENOENT")
        return new FolderListingError("NOT_FOUND", "filesystem directory was not found");
    if (code === "ENOTDIR")
        return new FolderListingError("NOT_DIRECTORY", "filesystem path is not a directory");
    if (code === "ELOOP" || code === "EINVAL" || code === "ENAMETOOLONG")
        return new FolderListingError("INVALID_PATH", "filesystem path is invalid");
    return new FolderListingError("INTERNAL", "failed to read filesystem directory");
}
function compareEntries(a, b) {
    if (a.type !== b.type)
        return a.type === "directory" ? -1 : 1;
    const folded = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return folded || a.name.localeCompare(b.name, undefined, { sensitivity: "variant" });
}
async function listEntries(directory) {
    let stat;
    let dirents;
    try {
        stat = await fs.stat(directory);
        if (!stat.isDirectory())
            throw new FolderListingError("NOT_DIRECTORY", "filesystem path is not a directory");
        dirents = await fs.readdir(directory, { withFileTypes: true });
    }
    catch (error) {
        if (error instanceof FolderListingError)
            throw error;
        throw filesystemError(error);
    }
    if (dirents.length > FOLDER_LISTING_MAX_ENTRIES) {
        throw new FolderListingError("LISTING_TOO_LARGE", `directory contains more than ${FOLDER_LISTING_MAX_ENTRIES} entries`);
    }
    const entries = [];
    const symlinks = [];
    for (const entry of dirents) {
        if (entry.isDirectory())
            entries.push({ name: entry.name, type: "directory" });
        else if (entry.isFile())
            entries.push({ name: entry.name, type: "file" });
        else if (entry.isSymbolicLink())
            symlinks.push(entry);
    }
    // A malicious or generated directory can contain thousands of symlinks.
    // Bound target-stat concurrency so one listing cannot exhaust file descriptors
    // or monopolize the libuv worker pool.
    for (let offset = 0; offset < symlinks.length; offset += SYMLINK_STAT_CONCURRENCY) {
        const batch = await Promise.all(symlinks.slice(offset, offset + SYMLINK_STAT_CONCURRENCY).map(async (entry) => {
            try {
                const target = await fs.stat(path.join(directory, entry.name));
                if (target.isDirectory())
                    return { name: entry.name, type: "directory" };
                if (target.isFile())
                    return { name: entry.name, type: "file" };
            }
            catch {
                // Broken, cyclic, and inaccessible links are inert and omitted.
            }
            return null;
        }));
        for (const entry of batch)
            if (entry)
                entries.push(entry);
    }
    entries.sort(compareEntries);
    const bytes = Buffer.byteLength(JSON.stringify(entries));
    if (bytes > FOLDER_LISTING_MAX_SNAPSHOT_BYTES) {
        throw new FolderListingError("LISTING_TOO_LARGE", "directory listing exceeds the snapshot byte limit");
    }
    return entries;
}
export class FolderListingChannel {
    capability = FOLDER_LISTING_CAPABILITY;
    projects;
    leaseMs;
    accepted = false;
    active = null;
    constructor(options = {}) {
        this.projects = options.projects ?? projectStore;
        this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    }
    helloState() { return {}; }
    started(_sender) { }
    connecting() { }
    negotiated(accepted, _acknowledgement, _sender) {
        this.accepted = accepted;
        if (!accepted)
            this.release();
    }
    disconnected(_resetAuthority) {
        this.accepted = false;
        this.release();
    }
    handles(frame) {
        return typeof frame.type === "string" && FRAME_TYPES.has(frame.type);
    }
    receive(frame, sender) {
        if (!this.accepted)
            return sender.disconnect("unnegotiated folder listing frame");
        const requestId = stringField(frame, "requestId", MAX_REQUEST_ID_LENGTH);
        if (!requestId)
            return this.error(sender, null, "BAD_REQUEST", "requestId is required");
        if (frame.type === "folder_list_cancel") {
            if (this.active?.requestId === requestId)
                this.release();
            return this.sendOrDisconnect(sender, { type: "folder_list_cancelled", requestId });
        }
        let limit;
        try {
            limit = requestedLimit(frame.limit);
        }
        catch (error) {
            return this.report(sender, requestId, error);
        }
        if (frame.cursor !== undefined) {
            const cursor = stringField(frame, "cursor", 200);
            if (!cursor || !this.active || this.active.requestId !== requestId || this.active.expectedCursor !== cursor || !this.active.entries) {
                return this.error(sender, requestId, "BAD_CURSOR", "invalid or unavailable folder listing cursor");
            }
            this.refreshLease();
            return this.sendPage(sender, this.active, limit);
        }
        if (this.active)
            return this.error(sender, requestId, "SYNC_IN_PROGRESS", "another folder listing is already active");
        let selection;
        try {
            selection = this.resolveSelection(frame);
        }
        catch (error) {
            return this.report(sender, requestId, error);
        }
        const active = {
            requestId,
            path: selection.path,
            projectId: selection.projectId,
            entries: null,
            offset: 0,
            expectedCursor: null,
            lease: setTimeout(() => {
                if (this.active === active)
                    this.release();
            }, this.leaseMs),
        };
        active.lease.unref();
        this.active = active;
        void listEntries(active.path).then((entries) => {
            if (this.active !== active)
                return;
            active.entries = entries;
            this.sendPage(sender, active, limit);
        }).catch((error) => {
            if (this.active !== active)
                return;
            this.release();
            this.report(sender, requestId, error);
        });
    }
    resolveSelection(frame) {
        if (frame.path !== undefined) {
            const requestedPath = stringField(frame, "path");
            if (!requestedPath || requestedPath.includes("\0"))
                throw new FolderListingError("INVALID_PATH", "path is invalid");
            if (!path.isAbsolute(requestedPath))
                throw new FolderListingError("BAD_REQUEST", "path must be absolute");
            return { path: path.resolve(requestedPath), projectId: null };
        }
        const projectId = stringField(frame, "projectId", 200);
        if (!projectId)
            throw new FolderListingError("BAD_REQUEST", "an absolute path or projectId is required");
        const project = this.projects.list().find((candidate) => candidate.projectId === projectId);
        if (!project)
            throw new FolderListingError("UNKNOWN_PROJECT", "unknown project");
        return { path: path.resolve(project.dir), projectId };
    }
    sendPage(sender, active, limit) {
        if (this.active !== active || !active.entries)
            return;
        const rows = [];
        let nextOffset = active.offset;
        while (nextOffset < active.entries.length && rows.length < limit) {
            const candidate = [...rows, active.entries[nextOffset]];
            const probe = this.pageFrame(active, candidate, nextOffset + 1, "00000000-0000-0000-0000-000000000000");
            if (Buffer.byteLength(JSON.stringify(probe)) > FOLDER_LISTING_MAX_PAGE_BYTES)
                break;
            rows.push(active.entries[nextOffset]);
            nextOffset += 1;
        }
        if (nextOffset === active.offset && nextOffset < active.entries.length) {
            this.release();
            return this.error(sender, active.requestId, "LISTING_TOO_LARGE", "one folder entry exceeds the page byte limit");
        }
        const hasMore = nextOffset < active.entries.length;
        const cursor = hasMore ? randomUUID() : null;
        const frame = this.pageFrame(active, rows, nextOffset, cursor);
        if (Buffer.byteLength(JSON.stringify(frame)) > FOLDER_LISTING_MAX_PAGE_BYTES) {
            this.release();
            return this.error(sender, active.requestId, "INTERNAL", "folder listing page exceeded its byte limit");
        }
        if (!sender.send(frame)) {
            this.release();
            return sender.disconnect("folder listing backpressure limit exceeded");
        }
        if (!hasMore)
            return this.release();
        active.offset = nextOffset;
        active.expectedCursor = cursor;
        this.refreshLease();
    }
    pageFrame(active, entries, nextOffset, cursor) {
        const hasMore = Boolean(active.entries && nextOffset < active.entries.length);
        return {
            type: "folder_list_page",
            requestId: active.requestId,
            path: active.path,
            projectId: active.projectId,
            entries,
            nextCursor: hasMore ? cursor : null,
            hasMore,
        };
    }
    refreshLease() {
        const active = this.active;
        if (!active)
            return;
        clearTimeout(active.lease);
        active.lease = setTimeout(() => {
            if (this.active === active)
                this.release();
        }, this.leaseMs);
        active.lease.unref();
    }
    release() {
        if (this.active)
            clearTimeout(this.active.lease);
        this.active = null;
    }
    report(sender, requestId, error) {
        if (error instanceof FolderListingError)
            return this.error(sender, requestId, error.code, error.message);
        this.error(sender, requestId, "INTERNAL", "failed to read filesystem directory");
    }
    error(sender, requestId, code, error) {
        this.sendOrDisconnect(sender, { type: "folder_list_error", requestId, code, error });
    }
    sendOrDisconnect(sender, frame) {
        if (!sender.send(frame))
            sender.disconnect("folder listing backpressure limit exceeded");
    }
}
