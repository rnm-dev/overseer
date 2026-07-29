import { watch } from "node:fs";
import path from "node:path";
export function attachHumanFilesystemRoutes(app, deps) {
    const { fileAccessService, watchDir = watch } = deps;
    // Generic host filesystem browser. The caller selects an absolute root;
    // `path` is still resolved strictly beneath that root so it cannot escape
    // through `..` or an external symlink. Project pages pass their own `dir`,
    // while other consumers can browse a different explicit root without first
    // manufacturing a project or session record.
    app.get("/api/v1/fs", (req, res) => {
        const root = typeof req.query.root === "string" ? req.query.root.trim() : "";
        if (!root || !path.isAbsolute(root))
            return res.status(400).json({ error: "root must be an absolute path" });
        const subpath = typeof req.query.path === "string" ? req.query.path : "";
        try {
            const absDir = fileAccessService.resolveWithinDir(root, subpath);
            if (!absDir)
                return res.status(400).json({ error: "path escapes root directory" });
            res.json({ path: fileAccessService.workspaceRelativePath(root, absDir), entries: fileAccessService.listDirEntries(root, absDir) });
        }
        catch (err) {
            const { status, message } = fileAccessService.dirErrorResponse(err);
            res.status(status).json({ error: message });
        }
    });
    // Live version of the above: streams an initial snapshot, then re-lists and
    // re-sends whenever `fs.watch` reports a change in the watched directory
    // (coalesced, since watch fires bursts per change). Powers the dashboard's
    // Files card so it stays current while open without polling.
    app.get("/api/v1/fs/stream", (req, res) => {
        const root = typeof req.query.root === "string" ? req.query.root.trim() : "";
        if (!root || !path.isAbsolute(root))
            return res.status(400).json({ error: "root must be an absolute path" });
        const subpath = typeof req.query.path === "string" ? req.query.path : "";
        let absDir;
        try {
            const resolved = fileAccessService.resolveWithinDir(root, subpath);
            if (!resolved)
                return res.status(400).json({ error: "path escapes root directory" });
            absDir = resolved;
        }
        catch (err) {
            const { status, message } = fileAccessService.dirErrorResponse(err);
            return res.status(status).json({ error: message });
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        const send = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        const relPath = fileAccessService.workspaceRelativePath(root, absDir);
        const pushSnapshot = () => {
            try {
                send("files", { path: relPath, entries: fileAccessService.listDirEntries(root, absDir) });
            }
            catch (err) {
                send("failed", { error: fileAccessService.dirErrorResponse(err).message });
            }
        };
        pushSnapshot();
        // Coalesce the burst of watch events a single change produces into one
        // re-read, and cap how often we re-list a busy directory.
        let timer = null;
        const schedule = () => {
            if (timer)
                return;
            timer = setTimeout(() => {
                timer = null;
                pushSnapshot();
            }, 150);
        };
        let watcher = null;
        try {
            watcher = watchDir(absDir, schedule);
            watcher.on("error", () => send("failed", { error: "watch failed" }));
        }
        catch {
            send("failed", { error: "watch failed" });
        }
        req.on("close", () => {
            if (timer)
                clearTimeout(timer);
            watcher?.close();
        });
    });
    // Contents of a single file under the caller-selected root. ?path= is
    // required and resolved strictly within that root (traversal 400s). Binary
    // files come back with content:null + binary:true; oversized files are
    // truncated to MAX_VIEW_BYTES with truncated:true.
    app.get("/api/v1/fs/file", (req, res) => {
        const root = typeof req.query.root === "string" ? req.query.root.trim() : "";
        if (!root || !path.isAbsolute(root))
            return res.status(400).json({ error: "root must be an absolute path" });
        const subpath = typeof req.query.path === "string" ? req.query.path : "";
        if (!subpath)
            return res.status(400).json({ error: "path is required" });
        try {
            const absPath = fileAccessService.resolveWithinDir(root, subpath);
            if (!absPath)
                return res.status(400).json({ error: "path escapes root directory" });
            const view = fileAccessService.readFileView(absPath);
            res.json({ ...view, path: fileAccessService.workspaceRelativePath(root, absPath) });
        }
        catch (err) {
            const { status, message } = fileAccessService.fileErrorResponse(err);
            res.status(status).json({ error: message });
        }
    });
}
