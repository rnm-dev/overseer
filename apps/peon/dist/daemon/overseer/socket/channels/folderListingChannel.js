import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { projectStore } from "../../../projects/index.js";
export const FOLDER_LISTING_CAPABILITY = "folder-listing-v1";
export const FOLDER_LISTING_ENTRY_METADATA = "entry-metadata-v1";
export const FOLDER_LISTING_MAX_PAGE_BYTES = 900 * 1024;
export const FOLDER_LISTING_MAX_ENTRIES = 20_000;
export const FOLDER_LISTING_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const DEFAULT_LEASE_MS = 30_000;
const MAX_REQUEST_ID_LENGTH = 200;
const MAX_SELECTOR_LENGTH = 4096;
const ENTRY_STAT_CONCURRENCY = 64;
const FRAME_TYPES = new Set(["folder_list_request", "folder_list_cancel"]);
class FolderListingError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
class FolderListingCancelled extends Error {
}
function stringField(frame, key, maxLength = MAX_SELECTOR_LENGTH) {
    const value = frame[key];
    return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null;
}
function relativePathField(frame) {
    const value = frame.relativePath;
    return typeof value === "string" && value.length <= MAX_SELECTOR_LENGTH && !value.includes("\0") ? value : null;
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
function cancelled(signal) {
    if (signal.aborted)
        throw new FolderListingCancelled();
}
function sameIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
}
function unsupportedPlatform() {
    return new FolderListingError("UNSUPPORTED_PLATFORM", "secure handle-relative folder listing is unavailable on this platform");
}
function requiredOpenFlags() {
    const values = [
        constants.O_RDONLY,
        constants.O_DIRECTORY,
        constants.O_NOFOLLOW,
        constants.O_NONBLOCK,
    ];
    if (values.some((value) => typeof value !== "number"))
        throw unsupportedPlatform();
    return {
        directoryFollow: constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK,
        directoryNoFollow: constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        entryFollow: constants.O_RDONLY | constants.O_NONBLOCK,
        entryNoFollow: constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    };
}
// Every path this channel touches is anchored to an open directory handle
// through the kernel's own view of that descriptor. Traversing
// `/proc/self/fd/N` restarts the walk from the pinned inode, which is what
// stops an ancestor from being swapped mid-listing. No other platform Peon
// runs on exposes an equivalent — Darwin's `fcntl(F_GETPATH)` reconstructs a
// path *string*, so reopening it is an ordinary racy lookup, not the same
// guarantee — and Node exposes no `openat`.
function defaultTrustedHandlePath(handle) {
    return supportsFolderListing() ? `/proc/self/fd/${handle.fd}` : null;
}
// Advertising a capability the platform can only ever answer with
// UNSUPPORTED_PLATFORM is worse than not advertising it: Overseer selects the
// socket exclusively, so the working HTTP path it would otherwise fall back to
// never runs. Withdraw the channel instead and let that negotiation decide.
export function supportsFolderListing(platform = process.platform) {
    return platform === "linux";
}
function anchoredPath(handle, openedPath, trustedHandlePath) {
    const value = trustedHandlePath(handle, openedPath);
    if (!value || !path.isAbsolute(value))
        throw unsupportedPlatform();
    return value;
}
function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function relativeEscapes(value) {
    return [path.posix, path.win32].some((api) => {
        const normalized = api.normalize(value);
        return api.isAbsolute(value) || normalized === ".." || normalized.startsWith(`..${api.sep}`);
    });
}
async function openDirectory(directory, followFinalSymlink, trustedHandlePath) {
    let handle = null;
    try {
        const flags = requiredOpenFlags();
        handle = await fs.open(directory, followFinalSymlink ? flags.directoryFollow : flags.directoryNoFollow);
        const stat = await handle.stat();
        if (!stat.isDirectory())
            throw new FolderListingError("NOT_DIRECTORY", "filesystem path is not a directory");
        return {
            handle,
            openedPath: directory,
            path: () => anchoredPath(handle, directory, trustedHandlePath),
            stat,
        };
    }
    catch (error) {
        await handle?.close().catch(() => { });
        if (error instanceof FolderListingError)
            throw error;
        throw filesystemError(error);
    }
}
async function realAnchoredPath(anchor) {
    try {
        return await fs.realpath(anchor.path());
    }
    catch (error) {
        if (error instanceof FolderListingError)
            throw error;
        throw unsupportedPlatform();
    }
}
function compareEntries(a, b) {
    const rank = { directory: 0, file: 1, other: 2 };
    if (a.type !== b.type)
        return rank[a.type] - rank[b.type];
    const folded = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return folded || a.name.localeCompare(b.name, undefined, { sensitivity: "variant" });
}
async function entryMetadata(directory, name, projectRoot, signal, trustedHandlePath, beforeEntryMetadata) {
    await beforeEntryMetadata?.(directory.openedPath, name, signal);
    cancelled(signal);
    const targetPath = path.join(directory.path(), name);
    let lexical;
    try {
        lexical = await fs.lstat(targetPath);
    }
    catch {
        return { name, type: "other", size: null, mtimeMs: null };
    }
    if (!lexical.isSymbolicLink() && !lexical.isDirectory() && !lexical.isFile()) {
        return { name, type: "other", size: null, mtimeMs: null };
    }
    let handle = null;
    try {
        const flags = requiredOpenFlags();
        handle = await fs.open(targetPath, lexical.isSymbolicLink() ? flags.entryFollow : flags.entryNoFollow);
        const target = await handle.stat();
        if (!lexical.isSymbolicLink() && !sameIdentity(lexical, target)) {
            return { name, type: "other", size: null, mtimeMs: null };
        }
        if (lexical.isSymbolicLink() && projectRoot) {
            const targetHandlePath = anchoredPath(handle, targetPath, trustedHandlePath);
            const realTarget = await fs.realpath(targetHandlePath);
            if (!isWithin(projectRoot, realTarget))
                return { name, type: "other", size: null, mtimeMs: null };
        }
        if (target.isDirectory())
            return { name, type: "directory", size: null, mtimeMs: target.mtimeMs };
        if (target.isFile())
            return { name, type: "file", size: target.size, mtimeMs: target.mtimeMs };
        return { name, type: "other", size: null, mtimeMs: null };
    }
    catch (error) {
        if (error instanceof FolderListingError || error instanceof FolderListingCancelled)
            throw error;
        // Broken, escaping, inaccessible, or concurrently changed children remain
        // visible but inert, matching the legacy project file API.
        return { name, type: "other", size: null, mtimeMs: null };
    }
    finally {
        await handle?.close().catch(() => { });
    }
}
async function listEntries(selection, signal, options) {
    cancelled(signal);
    const trustedHandlePath = options.trustedHandlePath ?? defaultTrustedHandlePath;
    let root = null;
    let directory = null;
    try {
        let projectRoot = null;
        let selectedPath = selection.path;
        if (selection.projectRoot) {
            const expectedRoot = await fs.realpath(selection.projectRoot);
            root = await openDirectory(expectedRoot, false, trustedHandlePath);
            projectRoot = await realAnchoredPath(root);
            if (projectRoot !== expectedRoot)
                throw new FolderListingError("PATH_ESCAPE", "project root changed during listing");
            selectedPath = selection.relativePath ? path.join(root.path(), selection.relativePath) : root.path();
        }
        directory = await openDirectory(selectedPath, true, trustedHandlePath);
        await options.afterDirectoryOpen?.(selection.path, signal);
        let resolvedDirectory = await realAnchoredPath(directory);
        if (projectRoot && !isWithin(projectRoot, resolvedDirectory)) {
            throw new FolderListingError("PATH_ESCAPE", "relativePath escapes the project root");
        }
        cancelled(signal);
        const dirents = await fs.readdir(directory.path(), { withFileTypes: true });
        await options.afterDirectoryRead?.(selection.path, signal);
        cancelled(signal);
        if (dirents.length > FOLDER_LISTING_MAX_ENTRIES) {
            throw new FolderListingError("LISTING_TOO_LARGE", `directory contains more than ${FOLDER_LISTING_MAX_ENTRIES} entries`);
        }
        const entries = [];
        for (let offset = 0; offset < dirents.length; offset += ENTRY_STAT_CONCURRENCY) {
            cancelled(signal);
            const batch = await Promise.allSettled(dirents.slice(offset, offset + ENTRY_STAT_CONCURRENCY).map((entry) => entryMetadata(directory, entry.name, projectRoot, signal, trustedHandlePath, options.beforeEntryMetadata)));
            const rejected = batch.find((result) => result.status === "rejected");
            if (rejected)
                throw rejected.reason;
            for (const result of batch)
                entries.push(result.value);
            cancelled(signal);
        }
        entries.sort(compareEntries);
        const bytes = Buffer.byteLength(JSON.stringify(entries));
        if (bytes > FOLDER_LISTING_MAX_SNAPSHOT_BYTES) {
            throw new FolderListingError("LISTING_TOO_LARGE", "directory listing exceeds the snapshot byte limit");
        }
        resolvedDirectory = await realAnchoredPath(directory);
        if (projectRoot && !isWithin(projectRoot, resolvedDirectory)) {
            throw new FolderListingError("PATH_ESCAPE", "filesystem directory moved outside the project during listing");
        }
        return { path: resolvedDirectory, entries };
    }
    finally {
        await directory?.handle.close().catch(() => { });
        await root?.handle.close().catch(() => { });
    }
}
export class FolderListingChannel {
    capability = FOLDER_LISTING_CAPABILITY;
    projects;
    leaseMs;
    scanOptions;
    accepted = false;
    sendEntryMetadata = false;
    active = null;
    constructor(options = {}) {
        this.projects = options.projects ?? projectStore;
        this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
        this.scanOptions = {
            trustedHandlePath: options.trustedHandlePath,
            afterDirectoryOpen: options.afterDirectoryOpen,
            afterDirectoryRead: options.afterDirectoryRead,
            beforeEntryMetadata: options.beforeEntryMetadata,
        };
    }
    helloState() {
        return { entryMetadata: FOLDER_LISTING_ENTRY_METADATA };
    }
    started(_sender) { }
    connecting() { }
    negotiated(accepted, acknowledgement, _sender) {
        this.accepted = accepted;
        const channels = acknowledgement.channels;
        const state = channels && typeof channels === "object" && !Array.isArray(channels)
            ? channels[FOLDER_LISTING_CAPABILITY]
            : null;
        this.sendEntryMetadata = accepted
            && Boolean(state && typeof state === "object" && !Array.isArray(state)
                && state.entryMetadata === FOLDER_LISTING_ENTRY_METADATA);
        if (!accepted && this.active)
            this.cancelActive(this.active);
    }
    disconnected(_resetAuthority) {
        this.accepted = false;
        this.sendEntryMetadata = false;
        if (this.active) {
            this.active.cancelAcknowledgements = [];
            this.cancelActive(this.active);
        }
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
            if (!this.active || this.active.requestId !== requestId) {
                return this.sendOrDisconnect(sender, { type: "folder_list_cancelled", requestId });
            }
            this.active.cancelAcknowledgements.push(sender);
            return this.cancelActive(this.active);
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
            selection,
            entries: null,
            offset: 0,
            expectedCursor: null,
            lease: null,
            controller: new AbortController(),
            scan: Promise.resolve(),
            scanSettled: false,
            cancelled: false,
            cancelAcknowledgements: [],
        };
        active.lease = setTimeout(() => {
            if (this.active === active)
                this.cancelActive(active);
        }, this.leaseMs);
        active.lease.unref();
        this.active = active;
        active.scan = this.scan(active, sender, limit);
    }
    resolveSelection(frame) {
        if (frame.path !== undefined) {
            if (frame.relativePath !== undefined)
                throw new FolderListingError("BAD_REQUEST", "relativePath requires projectId without path");
            const requestedPath = stringField(frame, "path");
            if (!requestedPath || requestedPath.includes("\0"))
                throw new FolderListingError("INVALID_PATH", "path is invalid");
            if (!path.isAbsolute(requestedPath))
                throw new FolderListingError("BAD_REQUEST", "path must be absolute");
            return {
                path: path.resolve(requestedPath),
                projectId: null,
                projectRoot: null,
                relativePath: "",
            };
        }
        const projectId = stringField(frame, "projectId", 200);
        if (!projectId)
            throw new FolderListingError("BAD_REQUEST", "an absolute path or projectId is required");
        const project = this.projects.list().find((candidate) => candidate.projectId === projectId);
        if (!project)
            throw new FolderListingError("UNKNOWN_PROJECT", "unknown project");
        const relativePath = frame.relativePath === undefined ? "" : relativePathField(frame);
        if (relativePath === null || relativeEscapes(relativePath)) {
            throw new FolderListingError("INVALID_PATH", "relativePath must stay relative to the project root");
        }
        return {
            path: path.resolve(project.dir, relativePath),
            projectId,
            projectRoot: project.dir,
            relativePath,
        };
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
            this.release(active);
            return this.error(sender, active.requestId, "LISTING_TOO_LARGE", "one folder entry exceeds the page byte limit");
        }
        const hasMore = nextOffset < active.entries.length;
        const cursor = hasMore ? randomUUID() : null;
        const frame = this.pageFrame(active, rows, nextOffset, cursor);
        if (Buffer.byteLength(JSON.stringify(frame)) > FOLDER_LISTING_MAX_PAGE_BYTES) {
            this.release(active);
            return this.error(sender, active.requestId, "INTERNAL", "folder listing page exceeded its byte limit");
        }
        if (!sender.send(frame)) {
            this.release(active);
            return sender.disconnect("folder listing backpressure limit exceeded");
        }
        if (!hasMore)
            return this.release(active);
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
            entries: this.sendEntryMetadata
                ? entries
                : entries.filter((entry) => entry.type !== "other").map(({ name, type }) => ({ name, type })),
            nextCursor: hasMore ? cursor : null,
            hasMore,
        };
    }
    refreshLease() {
        const active = this.active;
        if (!active)
            return;
        if (active.lease)
            clearTimeout(active.lease);
        active.lease = setTimeout(() => {
            if (this.active === active)
                this.cancelActive(active);
        }, this.leaseMs);
        active.lease.unref();
    }
    async scan(active, sender, limit) {
        try {
            const listing = await listEntries(active.selection, active.controller.signal, this.scanOptions);
            active.scanSettled = true;
            if (active.cancelled || this.active !== active)
                return this.finishCancellation(active);
            active.path = listing.path;
            active.entries = this.sendEntryMetadata
                ? listing.entries
                : listing.entries.filter((entry) => entry.type !== "other");
            this.sendPage(sender, active, limit);
        }
        catch (error) {
            active.scanSettled = true;
            if (active.cancelled || error instanceof FolderListingCancelled)
                return this.finishCancellation(active);
            if (this.active !== active)
                return;
            this.release(active);
            this.report(sender, active.requestId, error);
        }
    }
    cancelActive(active) {
        if (this.active !== active)
            return;
        active.cancelled = true;
        if (active.lease) {
            clearTimeout(active.lease);
            active.lease = null;
        }
        active.controller.abort();
        if (active.scanSettled)
            this.finishCancellation(active);
    }
    finishCancellation(active) {
        if (this.active !== active)
            return;
        const acknowledgements = [...active.cancelAcknowledgements];
        this.release(active);
        for (const sender of acknowledgements) {
            this.sendOrDisconnect(sender, { type: "folder_list_cancelled", requestId: active.requestId });
        }
    }
    release(active) {
        if (active.lease)
            clearTimeout(active.lease);
        active.lease = null;
        if (this.active === active)
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
