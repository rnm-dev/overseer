import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { MAX_VIEW_BYTES, } from "./contracts.js";
function defaultFileSystem() {
    return {
        closeSync,
        openSync,
        readSync,
        readdirSync: (pathToRead, options) => readdirSync(pathToRead, options),
        realpathSync,
        statSync,
    };
}
function isWithin(baseDir, target) {
    const rel = path.relative(baseDir, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
export class FileAccessService {
    fileSystem;
    constructor(options = {}) {
        const fallback = defaultFileSystem();
        this.fileSystem = {
            closeSync: options.fileSystem?.closeSync ?? fallback.closeSync,
            openSync: options.fileSystem?.openSync ?? fallback.openSync,
            readSync: options.fileSystem?.readSync ?? fallback.readSync,
            readdirSync: options.fileSystem?.readdirSync ?? fallback.readdirSync,
            realpathSync: options.fileSystem?.realpathSync ?? fallback.realpathSync,
            statSync: options.fileSystem?.statSync ?? fallback.statSync,
        };
    }
    resolveWithinDir(baseDir, subpath) {
        const lexical = path.resolve(baseDir, subpath);
        const lexicalRel = path.relative(path.resolve(baseDir), lexical);
        if (lexicalRel === ".." || lexicalRel.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRel))
            return null;
        const realBase = this.fileSystem.realpathSync(baseDir);
        const realTarget = this.fileSystem.realpathSync(lexical);
        return isWithin(realBase, realTarget) ? realTarget : null;
    }
    resolveFromDir(baseDir, subpath) {
        return this.fileSystem.realpathSync(path.resolve(baseDir, subpath));
    }
    workspaceRelativePath(baseDir, absPath) {
        return path.relative(this.fileSystem.realpathSync(baseDir), absPath);
    }
    listDirEntries(baseDir, absDir) {
        const realBase = this.fileSystem.realpathSync(baseDir);
        const entries = readdirEntries(absDir, this.fileSystem, realBase);
        entries.sort((a, b) => {
            if (a.type === "dir" && b.type !== "dir")
                return -1;
            if (a.type !== "dir" && b.type === "dir")
                return 1;
            return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
        });
        return entries;
    }
    readFileView(absPath) {
        const st = this.fileSystem.statSync(absPath);
        if (!st.isFile()) {
            const err = new Error("not a file");
            err.code = st.isDirectory() ? "EISDIR" : "EINVAL";
            throw err;
        }
        const bytesToRead = Math.min(st.size, MAX_VIEW_BYTES);
        const buffer = Buffer.allocUnsafe(bytesToRead);
        const fd = this.fileSystem.openSync(absPath, "r");
        let bytesRead = 0;
        try {
            while (bytesRead < bytesToRead) {
                const count = this.fileSystem.readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, bytesRead);
                if (count === 0)
                    break;
                bytesRead += count;
            }
        }
        finally {
            this.fileSystem.closeSync(fd);
        }
        const slice = buffer.subarray(0, bytesRead);
        const binary = slice.includes(0);
        return {
            size: st.size,
            mtimeMs: st.mtimeMs,
            binary,
            truncated: st.size > MAX_VIEW_BYTES,
            content: binary ? null : slice.toString("utf8"),
        };
    }
    dirErrorResponse(error) {
        const code = error.code;
        if (code === "ENOENT")
            return { status: 404, message: "directory not found" };
        if (code === "ENOTDIR")
            return { status: 400, message: "not a directory" };
        if (code === "EACCES")
            return { status: 403, message: "permission denied" };
        if (code === "EPERM")
            return { status: 403, message: "permission denied" };
        return { status: 500, message: "failed to read directory" };
    }
    fileErrorResponse(error) {
        const code = error.code;
        if (code === "ENOENT")
            return { status: 404, message: "file not found" };
        if (code === "EISDIR" || code === "EINVAL")
            return { status: 400, message: "not a file" };
        if (code === "EACCES")
            return { status: 403, message: "permission denied" };
        if (code === "EPERM")
            return { status: 403, message: "permission denied" };
        return { status: 500, message: "failed to read file" };
    }
}
function readdirEntries(absDir, fileSystem, realBase) {
    return fileSystem.readdirSync(absDir, { withFileTypes: true }).map((entry) => {
        const candidate = path.join(absDir, entry.name);
        let type = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
        let size = null;
        let mtimeMs = null;
        try {
            const realTarget = fileSystem.realpathSync(candidate);
            if (!isWithin(realBase, realTarget))
                return { name: entry.name, type: "other", size, mtimeMs };
            const st = fileSystem.statSync(realTarget);
            type = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
            size = st.isFile() ? st.size : null;
            mtimeMs = st.mtimeMs;
        }
        catch {
            type = "other";
        }
        return { name: entry.name, type, size, mtimeMs };
    });
}
