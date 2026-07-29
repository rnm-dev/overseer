import type { FileAccessContract } from "../../files/index.js";
import { fail } from "./error.js";
import { watch as createFileWatch, statSync } from "node:fs";
import path from "node:path";
import express from "express";
import type { SessionCatalogReader, SessionTranscriptEventContract } from "../../sessions/index.js";

export const INCLUDED_FLEET_SESSION_FILE_ROUTES = [
  "GET /sessions/:id/files",
  "GET /sessions/:id/file",
  "GET /sessions/:id/file/raw",
  "GET /sessions/:id/file/stream",
  "POST /sessions/:id/preview",
];

type SessionFileReader = Pick<SessionCatalogReader, "get">;
type SessionFilePreview = Pick<SessionTranscriptEventContract, "preview">;
type SessionFilesContract = SessionFileReader & SessionFilePreview;

export interface FleetSessionFileWatcher {
  close(): void;
  on?: (event: "error", listener: (error: unknown) => void) => void;
}

export type FleetSessionFileWatch = (
  filename: string,
  listener: (eventType: "rename" | "change", filename: string | Buffer | null) => void,
) => FleetSessionFileWatcher;

interface FleetSessionFileRoutesDeps {
  fileAccessService: FileAccessContract;
  sessionFiles: SessionFilesContract;
  watch?: FleetSessionFileWatch;
}

interface FleetSessionFileRouteOptions extends FleetSessionFileRoutesDeps {}

const PREVIEW_INLINE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

function failWorkspaceRead(res: express.Response, err: unknown, directory: boolean): void {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT") return fail(res, 404, "NOT_FOUND", directory ? "directory not found" : "file not found");
  if (code === "EISDIR" || code === "EINVAL") return fail(res, 400, "IS_DIRECTORY", "not a file");
  if (code === "ENOTDIR") return fail(res, 400, "BAD_REQUEST", "not a directory");
  fail(res, 500, "INTERNAL", directory ? "failed to read directory" : "failed to read file");
}

export function attachFleetSessionFileRoutes(router: express.Router, options: FleetSessionFileRouteOptions): void {
  const {
    fileAccessService,
    sessionFiles,
    watch = createFileWatch,
  } = options;

  router.get("/sessions/:id/files", (req, res) => {
    const record = sessionFiles.get(req.params.id);
    if (!record) return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    try {
      const absDir = fileAccessService.resolveFromDir(record.dir, subpath);
      res.json({ path: absDir, entries: fileAccessService.listDirEntries(absDir, absDir) });
    } catch (err) {
      failWorkspaceRead(res, err, true);
    }
  });

  router.get("/sessions/:id/file", (req, res) => {
    const record = sessionFiles.get(req.params.id);
    if (!record) return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    if (!subpath) return fail(res, 400, "BAD_REQUEST", "path is required");
    try {
      const absPath = fileAccessService.resolveFromDir(record.dir, subpath);
      res.json({ ...fileAccessService.readFileView(absPath), path: absPath });
    } catch (err) {
      failWorkspaceRead(res, err, false);
    }
  });

  router.get("/sessions/:id/file/raw", (req, res) => {
    const record = sessionFiles.get(req.params.id);
    if (!record) return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    if (!subpath) return fail(res, 400, "BAD_REQUEST", "path is required");
    const contentType = PREVIEW_INLINE_MIME_BY_EXT[path.extname(subpath).toLowerCase()] ?? "application/octet-stream";
    try {
      const absPath = fileAccessService.resolveFromDir(record.dir, subpath);
      if (!statSync(absPath).isFile()) return fail(res, 400, "IS_DIRECTORY", "path is not a file");
      res.setHeader("Content-Type", contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(absPath);
    } catch (err) {
      failWorkspaceRead(res, err, false);
    }
  });

  router.get("/sessions/:id/file/stream", (req, res) => {
    const record = sessionFiles.get(req.params.id);
    if (!record) return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    if (!subpath) return fail(res, 400, "BAD_REQUEST", "path is required");
    let absPath: string;
    try {
      absPath = fileAccessService.resolveFromDir(record.dir, subpath);
    } catch (err) {
      return failWorkspaceRead(res, err, false);
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const filename = path.basename(absPath);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = (changed: string | Buffer | null) => {
      if (changed !== null && String(changed) !== filename) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        res.write(`event: changed\ndata: ${JSON.stringify({ path: subpath })}\n\n`);
      }, 150);
    };

    let watcher: ReturnType<FleetSessionFileWatch> | null = null;
    try {
      watcher = watch(path.dirname(absPath), (_eventType, changed) => schedule(changed));
      watcher.on?.("error", () => {
        res.write(`event: failed\ndata: ${JSON.stringify({ error: "watch failed" })}\n\n`);
      });
    } catch {
      res.write(`event: failed\ndata: ${JSON.stringify({ error: "watch failed" })}\n\n`);
    }

    req.on("close", () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    });
  });

  router.post("/sessions/:id/preview", (req, res) => {
    const record = sessionFiles.get(req.params.id);
    if (!record) return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
    const requestedPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) return fail(res, 400, "BAD_REQUEST", "path is required");
    let absPath: string;
    try {
      absPath = fileAccessService.resolveFromDir(record.dir, requestedPath);
      if (!statSync(absPath).isFile()) return fail(res, 400, "IS_DIRECTORY", "path is not a file");
    } catch (err) {
      return failWorkspaceRead(res, err, false);
    }
    const event = sessionFiles.preview(record.id, absPath, req.actor ?? undefined);
    res.status(201).json({ event });
  });
}
