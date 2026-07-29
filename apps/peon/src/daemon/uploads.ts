import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import multer from "multer";
import type { Request } from "express";
import { attachmentsDir, type AttachmentInfo } from "./sessions/index.js";

// Set by controlServer.ts's assignSessionId middleware, ahead of the
// upload middleware, so a new session's attachments have somewhere to land
// before sessions.start() itself ever generates an id.
declare global {
  namespace Express {
    interface Request {
      acaSessionId?: string;
    }
  }
}

export const ATTACHMENTS_MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB/file
export const ATTACHMENTS_MAX_COUNT = 10;

// path.basename() strips any directory component the client claims a
// filename has (path-traversal defense); the charset restriction handles
// the rest (null bytes, control chars, anything a filesystem would choke
// on). Client-supplied filenames — including the synthetic
// "pasted-image-…" names the frontend generates for clipboard pastes — are
// never trusted as-is, regardless of where they came from.
export function sanitizeFilename(original: string): string {
  const base = path.basename(original).replace(/[^A-Za-z0-9._-]/g, "_").slice(-150);
  return base && base !== "." && base !== ".." ? base : `file-${Date.now()}`;
}

// Two uploads landing on the same name within one session's lifetime (two
// files in one request, or a later follow-up reusing a name from an
// earlier one) get suffixed rather than overwritten. Scans the whole
// per-session attachments/ dir, not just the current request's files —
// exactly why attachments live in one shared per-session dir rather than a
// per-message subdirectory.
function dedupeFilename(dir: string, name: string): string {
  if (!existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; ; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!existsSync(path.join(dir, candidate))) return candidate;
  }
}

// getSessionId differs per route: the new-session route pre-generates an id
// before sessions.start() is ever called, the follow-up route already has
// one from the URL param.
export function createAttachmentUpload(getSessionId: (req: Request) => string) {
  const storage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = attachmentsDir(getSessionId(req));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const dir = attachmentsDir(getSessionId(req));
      cb(null, dedupeFilename(dir, sanitizeFilename(file.originalname)));
    },
  });
  return multer({
    storage,
    limits: { fileSize: ATTACHMENTS_MAX_FILE_BYTES, files: ATTACHMENTS_MAX_COUNT },
  }).array("files", ATTACHMENTS_MAX_COUNT);
}

export function describeUploadError(err: unknown): string {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return `file too large (max ${ATTACHMENTS_MAX_FILE_BYTES / (1024 * 1024)}MB per file)`;
    }
    if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
      return `too many files (max ${ATTACHMENTS_MAX_COUNT})`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function cleanupUploadedFiles(files: Express.Multer.File[]): void {
  for (const f of files) {
    try {
      unlinkSync(f.path);
    } catch {
      // best-effort — the request is already failing for another reason
    }
  }
}

export function toAttachmentInfo(files: Express.Multer.File[]): AttachmentInfo[] {
  return files.map((f) => ({
    originalName: f.originalname,
    filename: f.filename,
    path: f.path,
    size: f.size,
    mimetype: f.mimetype,
  }));
}
