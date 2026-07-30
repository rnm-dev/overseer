import { createHash } from "node:crypto";
import { lstat, readFile, realpath, readdir } from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
export const PREVIEW_REVISION_LIMITS = Object.freeze({
    maxAssetBytes: 8 * 1024 * 1024,
    maxRevisionBytes: 32 * 1024 * 1024,
    maxAssets: 256,
    debounceMs: 150,
});
const CONTENT_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".txt": "text/plain; charset=utf-8",
    ".webp": "image/webp",
};
/**
 * Filesystem producer for the existing session-artifact transfer owner.
 * Publications are complete immutable revisions; callers stream their assets
 * with the base credited reader before advertising activation.
 */
export class PreviewRevisionPublisher {
    state;
    publish;
    now;
    limits;
    publishers = new Map();
    expiryTimer = null;
    constructor(state, publish, now = Date.now, limits = PREVIEW_REVISION_LIMITS) {
        this.state = state;
        this.publish = publish;
        this.now = now;
        this.limits = limits;
    }
    async watch(leaseId, root, relativePath, expiresAt) {
        const resolved = await this.resolveContained(root, relativePath, true);
        const key = `${resolved.root}\0${relativePath}`;
        const { shared } = this.state.add({ leaseId, key, expiresAt });
        if (!shared) {
            const publisher = {
                root: resolved.root,
                relativePath,
                watchers: [],
                timer: null,
                running: false,
                dirty: false,
            };
            try {
                this.publishers.set(key, publisher);
                publisher.watchers = await this.installWatchers(key, resolved.root, resolved.absolute);
            }
            catch (error) {
                this.publishers.delete(key);
                this.state.remove(leaseId);
                throw error;
            }
        }
        this.ensureExpiryTimer();
        this.schedule(key, 0);
    }
    renew(leaseId, expiresAt) {
        return this.state.renew(leaseId, expiresAt);
    }
    unwatch(leaseId) {
        const before = this.state.snapshot().find((watchState) => watchState.leases.some((lease) => lease.leaseId === leaseId));
        const result = this.state.remove(leaseId);
        if (result.watchReleased && before)
            this.releasePublisher(before.key);
        this.stopExpiryTimerIfIdle();
        return result.removed;
    }
    reconcileRevisionFloor(revision) {
        this.state.reconcileRevisionFloor(revision);
    }
    close() {
        if (this.expiryTimer)
            clearInterval(this.expiryTimer);
        this.expiryTimer = null;
        for (const key of [...this.publishers.keys()])
            this.releasePublisher(key);
        this.state.clear();
    }
    schedule(key, delay = this.limits.debounceMs) {
        const publisher = this.publishers.get(key);
        if (!publisher)
            return;
        publisher.dirty = true;
        if (publisher.timer)
            clearTimeout(publisher.timer);
        publisher.timer = setTimeout(() => {
            publisher.timer = null;
            void this.drain(key);
        }, delay);
        publisher.timer.unref();
    }
    async drain(key) {
        const publisher = this.publishers.get(key);
        if (!publisher || publisher.running)
            return;
        publisher.running = true;
        try {
            while (publisher.dirty && this.publishers.get(key) === publisher) {
                publisher.dirty = false;
                const revision = this.state.begin(key);
                const publication = await this.snapshot(publisher, revision);
                if (publisher.dirty || this.publishers.get(key) !== publisher)
                    continue;
                const accepted = await this.publish(publication);
                if (!accepted || !this.state.activate(revision)) {
                    // Backpressure or a newer generation keeps this revision inactive.
                    if (this.publishers.get(key) === publisher)
                        publisher.dirty = true;
                    break;
                }
                await this.refreshWatchers(key, publisher);
            }
        }
        catch (error) {
            const code = error.code;
            const message = error instanceof Error ? error.message : "";
            if (this.publishers.get(key) === publisher
                && (message === "PREVIEW_CHANGED_DURING_READ" || code === "ENOENT" || code === "EBUSY")) {
                publisher.dirty = true;
            }
            else {
                this.releaseKey(key);
            }
        }
        finally {
            publisher.running = false;
            if (publisher.dirty && this.publishers.get(key) === publisher)
                this.schedule(key, 0);
        }
    }
    async snapshot(publisher, revision) {
        let entry;
        try {
            entry = await this.resolveContained(publisher.root, publisher.relativePath, false);
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return { ...revision, entryPath: publisher.relativePath, deleted: true, assets: [] };
            }
            throw error;
        }
        const paths = path.extname(entry.absolute).toLowerCase() === ".html"
            ? await this.collectFiles(entry.root, path.dirname(entry.absolute))
            : [entry.absolute];
        const assets = [];
        let total = 0;
        for (const absolute of paths) {
            const before = await lstat(absolute);
            if (!before.isFile() || before.isSymbolicLink())
                throw new Error("INVALID_PREVIEW_TYPE");
            if (before.size > this.limits.maxAssetBytes)
                throw new Error("PREVIEW_ASSET_TOO_LARGE");
            const bytes = await readFile(absolute);
            const after = await lstat(absolute);
            if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
                throw new Error("PREVIEW_CHANGED_DURING_READ");
            }
            total += bytes.length;
            if (total > this.limits.maxRevisionBytes)
                throw new Error("PREVIEW_REVISION_TOO_LARGE");
            assets.push({
                path: path.relative(entry.root, absolute).split(path.sep).join("/"),
                size: bytes.length,
                sha256: createHash("sha256").update(bytes).digest("hex"),
                contentType: CONTENT_TYPES[path.extname(absolute).toLowerCase()] ?? "application/octet-stream",
                bytes,
            });
        }
        return { ...revision, entryPath: publisher.relativePath, deleted: false, assets };
    }
    async collectFiles(root, directory) {
        const collected = [];
        let visited = 0;
        const visit = async (current) => {
            for (const entry of await readdir(current, { withFileTypes: true })) {
                visited += 1;
                if (visited > this.limits.maxAssets * 2 || collected.length >= this.limits.maxAssets) {
                    throw new Error("PREVIEW_ASSET_LIMIT");
                }
                const absolute = path.join(current, entry.name);
                if (entry.isSymbolicLink())
                    throw new Error("PREVIEW_SYMLINK");
                if (entry.isDirectory())
                    await visit(absolute);
                else if (entry.isFile()) {
                    await this.assertContained(root, absolute);
                    collected.push(absolute);
                }
            }
        };
        await visit(directory);
        return collected.sort();
    }
    async installWatchers(key, root, entry) {
        const directories = [path.dirname(entry)];
        if (path.extname(entry).toLowerCase() === ".html") {
            for (let index = 0; index < directories.length; index += 1) {
                if (directories.length > this.limits.maxAssets)
                    throw new Error("PREVIEW_DIRECTORY_LIMIT");
                for (const child of await readdir(directories[index], { withFileTypes: true })) {
                    if (child.isSymbolicLink())
                        continue;
                    if (child.isDirectory())
                        directories.push(path.join(directories[index], child.name));
                }
            }
        }
        const watchers = [];
        try {
            for (const directory of directories) {
                await this.assertContained(root, directory);
                const watcher = watch(directory, () => this.schedule(key));
                watcher.on("error", () => this.releaseKey(key));
                watchers.push(watcher);
            }
            return watchers;
        }
        catch (error) {
            for (const watcher of watchers)
                watcher.close();
            throw error;
        }
    }
    async refreshWatchers(key, publisher) {
        const resolved = await this.resolveContained(publisher.root, publisher.relativePath, true);
        const next = await this.installWatchers(key, resolved.root, resolved.absolute);
        const previous = publisher.watchers;
        publisher.watchers = next;
        for (const watcher of previous)
            watcher.close();
    }
    async resolveContained(root, relativePath, allowMissing) {
        if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0") || relativePath.includes("\\")
            || relativePath.split("/").includes("..") || Buffer.byteLength(relativePath) > 4096) {
            throw new Error("INVALID_PREVIEW_PATH");
        }
        const canonicalRoot = await realpath(root);
        const candidate = path.resolve(canonicalRoot, relativePath);
        if (allowMissing) {
            try {
                const canonical = await realpath(candidate);
                await this.assertContained(canonicalRoot, canonical);
                return { root: canonicalRoot, absolute: canonical };
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
                await this.assertContained(canonicalRoot, path.dirname(candidate));
                return { root: canonicalRoot, absolute: candidate };
            }
        }
        const canonical = await realpath(candidate);
        await this.assertContained(canonicalRoot, canonical);
        return { root: canonicalRoot, absolute: canonical };
    }
    async assertContained(root, candidate) {
        const canonical = await realpath(candidate);
        if (canonical !== root && !canonical.startsWith(`${root}${path.sep}`))
            throw new Error("PREVIEW_PATH_ESCAPE");
    }
    ensureExpiryTimer() {
        if (this.expiryTimer)
            return;
        this.expiryTimer = setInterval(() => {
            for (const key of this.state.expire(this.now())) {
                this.releasePublisher(key);
            }
            this.stopExpiryTimerIfIdle();
        }, 1_000);
        this.expiryTimer.unref();
    }
    stopExpiryTimerIfIdle() {
        if (this.publishers.size > 0 || !this.expiryTimer)
            return;
        clearInterval(this.expiryTimer);
        this.expiryTimer = null;
    }
    releaseKey(key) {
        const watchState = this.state.snapshot().find((item) => item.key === key);
        for (const lease of watchState?.leases ?? [])
            this.state.remove(lease.leaseId);
        this.releasePublisher(key);
        this.stopExpiryTimerIfIdle();
    }
    releasePublisher(key) {
        const publisher = this.publishers.get(key);
        if (!publisher)
            return;
        this.publishers.delete(key);
        if (publisher.timer)
            clearTimeout(publisher.timer);
        for (const watcher of publisher.watchers)
            watcher.close();
    }
}
