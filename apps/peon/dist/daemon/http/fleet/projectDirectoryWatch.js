import { DirectoryWatchRegistry, directoryWatchTarget } from "../../files/index.js";
export function attachProjectDirectoryWatch(router, projects, watches = new DirectoryWatchRegistry()) {
    let streams = 0;
    router.get("/projects/:key/files-watch", (req, res) => {
        const key = req.params.key;
        const project = projects.get(key);
        if (!project) {
            res.status(404).end();
            return;
        }
        const root = project.dir;
        const projectId = project.projectId;
        if (req.query.projectId !== undefined && req.query.projectId !== projectId) {
            res.status(409).end();
            return;
        }
        if (streams >= 2048) {
            res.status(429).end();
            return;
        }
        const relative = req.query.path ?? "";
        if (typeof relative !== "string") {
            res.status(400).end();
            return;
        }
        let target;
        try {
            target = directoryWatchTarget(root, relative);
        }
        catch {
            res.status(400).end();
            return;
        }
        let closed = false;
        let release;
        let heartbeat;
        const close = () => {
            if (closed)
                return;
            closed = true;
            streams--;
            clearInterval(heartbeat);
            release?.();
            res.end();
        };
        const valid = () => {
            const current = projects.get(key);
            return current?.dir === root && current?.projectId === projectId && target.valid();
        };
        const emit = (event) => {
            // A slow relay reconnects and rereads; never accumulate invalidations.
            if (!closed && !res.write(`event: ${event}\ndata: {}\n\n`))
                close();
        };
        streams++;
        try {
            release = watches.subscribe(target.directory, (event) => {
                if (event === "failed" || !valid()) {
                    emit("failed");
                    close();
                }
                else
                    emit("changed");
            });
        }
        catch {
            res.status(503);
            close();
            return;
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders();
        res.on("close", close);
        // Install before ready: every subscription/reconnect requires a fresh HTTP
        // listing, covering changes between the initial listing and this watch.
        if (!valid()) {
            emit("failed");
            close();
            return;
        }
        emit("ready");
        if (closed)
            return;
        heartbeat = setInterval(() => {
            if (!valid()) {
                emit("failed");
                close();
            }
            else if (!res.write(": heartbeat\n\n"))
                close();
        }, 15_000);
        heartbeat.unref();
    });
}
