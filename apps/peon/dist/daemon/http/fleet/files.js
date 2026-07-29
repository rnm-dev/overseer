import { createHash, randomUUID } from "node:crypto";
import { createReadStream, lstatSync, realpathSync, statSync } from "node:fs";
import { promises as fsPromises } from "node:fs";
import path from "node:path";
import { ATTACHMENTS_MAX_FILE_BYTES } from "../../uploads.js";
import { fail } from "./error.js";
class ProjectUploadError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
function hashFile(abs) {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(abs)
            .on("error", reject)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => resolve(hash.digest("hex")));
    });
}
function withinRoot(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function uploadFsError(err, fallback = "safe project file write failed") {
    const code = err.code;
    if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
        return new ProjectUploadError(403, "FORBIDDEN", "destination is not writable");
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
        return new ProjectUploadError(404, "PARENT_NOT_FOUND", "destination parent directory does not exist");
    }
    return new ProjectUploadError(500, "WRITE_FAILED", fallback);
}
function validateUploadDestination(root, absPath) {
    let destination;
    try {
        destination = lstatSync(absPath);
    }
    catch (err) {
        if (err.code === "ENOENT")
            return;
        throw uploadFsError(err, "failed to inspect upload destination");
    }
    if (destination.isSymbolicLink()) {
        try {
            const resolved = realpathSync(absPath);
            if (!withinRoot(root, resolved)) {
                throw new ProjectUploadError(400, "PATH_ESCAPE", "destination symlink escapes the project root");
            }
        }
        catch (err) {
            if (err instanceof ProjectUploadError)
                throw err;
            // Broken and inaccessible links are still non-regular destinations.
        }
        throw new ProjectUploadError(400, "INVALID_PATH", "destination must be a regular file");
    }
    if (!destination.isFile()) {
        throw new ProjectUploadError(400, "INVALID_PATH", "destination must be a regular file");
    }
}
function projectFileTarget(record, requested) {
    const parts = requested.split("/");
    if (path.isAbsolute(requested) || path.win32.isAbsolute(requested) || parts.some((part) => part === "..")) {
        throw new ProjectUploadError(400, "PATH_ESCAPE", "project file path escapes the project root");
    }
    if (!requested || parts.some((part) => !part || part === ".")) {
        throw new ProjectUploadError(400, "INVALID_PATH", "project file path must name a file");
    }
    if (requested.includes("\\") || /[\0-\x1f\x7f]/.test(requested)) {
        throw new ProjectUploadError(400, "INVALID_PATH", "project file path contains a malformed segment");
    }
    let root;
    try {
        root = realpathSync(record.dir);
        if (!statSync(root).isDirectory())
            throw new Error("project root is not a directory");
    }
    catch (err) {
        throw uploadFsError(err, "configured project root is unavailable");
    }
    const lexical = path.resolve(root, ...parts);
    if (!withinRoot(root, lexical) || lexical === root) {
        throw new ProjectUploadError(400, "PATH_ESCAPE", "project file path escapes the project root");
    }
    const parentLexical = path.dirname(lexical);
    let parentReal;
    let parentStat;
    try {
        parentReal = realpathSync(parentLexical);
        parentStat = statSync(parentReal);
    }
    catch (err) {
        throw uploadFsError(err);
    }
    if (!withinRoot(root, parentReal)) {
        throw new ProjectUploadError(400, "PATH_ESCAPE", "destination parent escapes the project root");
    }
    if (!parentStat.isDirectory()) {
        throw new ProjectUploadError(404, "PARENT_NOT_FOUND", "destination parent directory does not exist");
    }
    const absPath = path.join(parentReal, path.basename(lexical));
    validateUploadDestination(root, absPath);
    return {
        rootReal: root,
        absPath,
        parentLexical,
        parentReal,
        parentDevice: parentStat.dev,
        parentInode: parentStat.ino,
        relativePath: parts.join("/"),
    };
}
function projectUploadTarget(record, req) {
    return projectFileTarget(record, segmentsPath(req));
}
function revalidateProjectUploadTarget(record, target) {
    let root;
    let parentReal;
    let parentStat;
    try {
        root = realpathSync(record.dir);
        parentReal = realpathSync(target.parentLexical);
        parentStat = statSync(parentReal);
    }
    catch (err) {
        throw uploadFsError(err);
    }
    if (root !== target.rootReal ||
        parentReal !== target.parentReal ||
        parentStat.dev !== target.parentDevice ||
        parentStat.ino !== target.parentInode ||
        !withinRoot(root, parentReal)) {
        throw new ProjectUploadError(400, "PATH_ESCAPE", "destination parent changed during upload");
    }
    validateUploadDestination(root, target.absPath);
}
function failWorkspaceRead(res, err, directory) {
    const code = err.code;
    if (code === "ENOENT")
        return fail(res, 404, "NOT_FOUND", directory ? "directory not found" : "file not found");
    if (code === "EISDIR" || code === "EINVAL")
        return fail(res, 400, "IS_DIRECTORY", "not a file");
    if (code === "ENOTDIR")
        return fail(res, 400, "BAD_REQUEST", "not a directory");
    fail(res, 500, "INTERNAL", directory ? "failed to read directory" : "failed to read file");
}
function segmentsPath(req) {
    return (req.params.rest ?? []).join("/");
}
export function attachFleetProjectFileRoutes(router, options) {
    const { fileAccessService, projectReader, failWorkspaceRead: failWorkspaceReadOverride, } = options;
    const respondProjectRead = failWorkspaceReadOverride ?? failWorkspaceRead;
    // Validate raw project URLs before Express decodes wildcard parameters. Its
    // default malformed-percent behavior is a connection-level URIError, while
    // the machine API promises a stable JSON failure.
    router.use("/projects", (req, res, next) => {
        try {
            decodeURI(req.originalUrl.split("?", 1)[0]);
            next();
        }
        catch {
            fail(res, 400, "INVALID_PATH", "project path contains a malformed segment");
        }
    });
    router.get(["/projects/:key/files", "/projects/:key/files/{*rest}"], async (req, res) => {
        const record = projectReader.get(req.params.key);
        if (!record)
            return fail(res, 404, "UNKNOWN_PROJECT", "unknown project");
        const segments = req.params.rest ?? [];
        const subpath = segments.join("/");
        let absPath;
        try {
            // Escapes (.., encoded traversal, absolute-looking joins, symlinks
            // leaving the root) return null here — checked *before* any stat/read,
            // so an escape never discloses external metadata or content.
            absPath = fileAccessService.resolveWithinDir(record.dir, subpath);
        }
        catch (err) {
            return respondProjectRead(res, err, false);
        }
        if (absPath === null)
            return fail(res, 400, "PATH_ESCAPE", `requested path escapes the project root: ${subpath}`);
        let stat;
        try {
            stat = statSync(absPath);
        }
        catch (err) {
            return respondProjectRead(res, err, false);
        }
        const relPath = fileAccessService.workspaceRelativePath(record.dir, absPath);
        if (req.query.stat !== undefined) {
            if (stat.isDirectory()) {
                return res.json({ path: relPath, entries: fileAccessService.listDirEntries(record.dir, absPath) });
            }
            return res.json({ path: relPath, type: "file", size: stat.size, mtimeMs: stat.mtimeMs, sha256: await hashFile(absPath) });
        }
        if (stat.isDirectory())
            return fail(res, 400, "IS_DIRECTORY", "path is a directory — use ?stat=1 to list it");
        // `send` (which sendFile wraps) 404s dotfiles by default — a project
        // legitimately contains .gitignore/.env/.github, so allow them; we've
        // already sandboxed the path ourselves above.
        res.sendFile(absPath, { dotfiles: "allow" }, (err) => {
            if (err && !res.headersSent)
                fail(res, 500, "INTERNAL", "failed to send file");
        });
    });
    router.put("/projects/:key/files/{*rest}", async (req, res) => {
        const record = projectReader.get(req.params.key);
        if (!record)
            return fail(res, 404, "UNKNOWN_PROJECT", "unknown project");
        let target;
        try {
            target = projectUploadTarget(record, req);
        }
        catch (err) {
            const failure = err instanceof ProjectUploadError ? err : uploadFsError(err);
            return fail(res, failure.status, failure.code, failure.message);
        }
        const claimed = typeof req.headers["peon-content-sha256"] === "string"
            ? req.headers["peon-content-sha256"].trim().toLowerCase()
            : null;
        const contentLength = Number(req.headers["content-length"]);
        if (Number.isFinite(contentLength) && contentLength > ATTACHMENTS_MAX_FILE_BYTES) {
            return fail(res, 413, "FILE_TOO_LARGE", `file exceeds ${ATTACHMENTS_MAX_FILE_BYTES / (1024 * 1024)}MB limit`);
        }
        const tmp = path.join(target.parentReal, `.${path.basename(target.absPath)}.peon-upload-${randomUUID()}`);
        let handle = null;
        let committed = false;
        let bytes = 0;
        const hash = createHash("sha256");
        try {
            handle = await fsPromises.open(tmp, "wx", 0o666);
            for await (const value of req) {
                const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
                bytes += chunk.length;
                if (bytes > ATTACHMENTS_MAX_FILE_BYTES) {
                    throw new ProjectUploadError(413, "FILE_TOO_LARGE", `file exceeds ${ATTACHMENTS_MAX_FILE_BYTES / (1024 * 1024)}MB limit`);
                }
                hash.update(chunk);
                let offset = 0;
                while (offset < chunk.length) {
                    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset, null);
                    if (bytesWritten === 0)
                        throw new Error("zero-byte write");
                    offset += bytesWritten;
                }
            }
            if (req.aborted)
                throw new Error("request aborted before upload completed");
            await handle.sync();
            await handle.close();
            handle = null;
            const sha256 = hash.digest("hex");
            if (claimed && claimed !== sha256) {
                throw new ProjectUploadError(409, "CHECKSUM_MISMATCH", `body sha256 ${sha256} does not match Peon-Content-Sha256 ${claimed}`);
            }
            revalidateProjectUploadTarget(record, target);
            await fsPromises.rename(tmp, target.absPath);
            committed = true;
            res.status(201).json({ path: target.relativePath, size: bytes, sha256 });
        }
        catch (err) {
            if (handle) {
                try {
                    await handle.close();
                }
                catch { /* cleanup below is authoritative */ }
                handle = null;
            }
            if (!committed) {
                try {
                    await fsPromises.unlink(tmp);
                }
                catch { /* final cleanup retries */ }
            }
            if (!req.aborted && !res.headersSent && !res.destroyed) {
                const failure = err instanceof ProjectUploadError ? err : uploadFsError(err);
                fail(res, failure.status, failure.code, failure.message);
            }
        }
        finally {
            if (!committed) {
                try {
                    await fsPromises.unlink(tmp);
                }
                catch { /* absent temp is already clean */ }
            }
        }
    });
    router.patch("/projects/:key/files/{*rest}", async (req, res) => {
        const record = projectReader.get(req.params.key);
        if (!record)
            return fail(res, 404, "UNKNOWN_PROJECT", "unknown project");
        const destination = typeof req.body?.destination === "string" ? req.body.destination : "";
        try {
            const source = projectFileTarget(record, segmentsPath(req));
            const destinationTarget = projectFileTarget(record, destination);
            if (source.absPath === destinationTarget.absPath) {
                throw new ProjectUploadError(400, "INVALID_PATH", "source and destination must differ");
            }
            const sourceStat = lstatSync(source.absPath);
            if (!sourceStat.isFile()) {
                throw new ProjectUploadError(400, "INVALID_PATH", "source must be a regular file");
            }
            try {
                lstatSync(destinationTarget.absPath);
                throw new ProjectUploadError(409, "DESTINATION_EXISTS", "destination already exists");
            }
            catch (err) {
                if (err instanceof ProjectUploadError)
                    throw err;
                if (err.code !== "ENOENT")
                    throw err;
            }
            revalidateProjectUploadTarget(record, source);
            revalidateProjectUploadTarget(record, destinationTarget);
            const currentSource = lstatSync(source.absPath);
            if (currentSource.dev !== sourceStat.dev || currentSource.ino !== sourceStat.ino || !currentSource.isFile()) {
                throw new ProjectUploadError(500, "WRITE_FAILED", "source changed while preparing move");
            }
            // validateProjectUploadTarget permits an absent destination; reject a
            // late arrival immediately before the atomic rename.
            try {
                lstatSync(destinationTarget.absPath);
                throw new ProjectUploadError(409, "DESTINATION_EXISTS", "destination already exists");
            }
            catch (err) {
                if (err instanceof ProjectUploadError)
                    throw err;
                if (err.code !== "ENOENT")
                    throw err;
            }
            await fsPromises.rename(source.absPath, destinationTarget.absPath);
            res.json({ path: destinationTarget.relativePath, size: sourceStat.size });
        }
        catch (err) {
            if (err.code === "ENOENT") {
                return fail(res, 404, "NOT_FOUND", "source file does not exist");
            }
            const failure = err instanceof ProjectUploadError ? err : uploadFsError(err, "safe project file move failed");
            fail(res, failure.status, failure.code, failure.message);
        }
    });
    router.delete("/projects/:key/files/{*rest}", async (req, res) => {
        const record = projectReader.get(req.params.key);
        if (!record)
            return fail(res, 404, "UNKNOWN_PROJECT", "unknown project");
        try {
            const target = projectFileTarget(record, segmentsPath(req));
            const before = lstatSync(target.absPath);
            if (!before.isFile()) {
                throw new ProjectUploadError(400, "INVALID_PATH", "delete target must be a regular file");
            }
            revalidateProjectUploadTarget(record, target);
            const current = lstatSync(target.absPath);
            if (current.dev !== before.dev || current.ino !== before.ino || !current.isFile()) {
                throw new ProjectUploadError(500, "WRITE_FAILED", "file changed while preparing delete");
            }
            await fsPromises.unlink(target.absPath);
            res.json({ path: target.relativePath, size: before.size });
        }
        catch (err) {
            if (err.code === "ENOENT") {
                return fail(res, 404, "NOT_FOUND", "file does not exist");
            }
            const failure = err instanceof ProjectUploadError ? err : uploadFsError(err, "safe project file delete failed");
            fail(res, failure.status, failure.code, failure.message);
        }
    });
}
