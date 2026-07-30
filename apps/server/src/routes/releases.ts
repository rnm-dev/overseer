import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import express from "express";
import { config } from "../config.js";
import { ensureReleaseFile, getRelease, latestRelease, publishRelease, ReleaseError, type ReleaseRecord } from "../releases.js";
import { bearer, credentialAuth } from "./helpers.js";

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

function publisherAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!config.releaseToken) {
    res.status(503).json({ error: "release publishing is not configured", code: "RELEASE_PUBLISHING_DISABLED" });
    return;
  }
  if (!timingSafeEqual(digest(bearer(req)), digest(config.releaseToken))) {
    res.status(401).json({ error: "invalid release publisher token", code: "UNAUTHENTICATED" });
    return;
  }
  next();
}

const view = (release: ReleaseRecord) => ({
  version: release.version,
  revision: release.storageKey,
  size: release.size,
  sha256: release.sha256,
  createdAt: release.createdAt,
  archiveUrl: `/api/v1/releases/${encodeURIComponent(release.version)}/archive`,
});

function sendError(error: unknown, res: express.Response): void {
  if (error instanceof ReleaseError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  res.status(500).json({ error: "release storage operation failed", code: "RELEASE_STORAGE_FAILED" });
}

export function releasePublisherRouter(): express.Router {
  const router = express.Router();
  router.put("/releases/:version", publisherAuth, async (req, res) => {
    try {
      res.status(201).json({ release: view(await publishRelease(String(req.params.version), req)) });
    } catch (error) {
      sendError(error, res);
    }
  });
  return router;
}

function byteRange(value: string | undefined, size: number): { start: number; end: number } | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) return "invalid";
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

export function peonReleasesRouter(): express.Router {
  const router = express.Router();
  router.use(credentialAuth);
  router.get("/latest", async (_req, res) => {
    const release = await latestRelease();
    if (!release) return res.status(404).json({ error: "no releases have been published", code: "NO_RELEASES" });
    res.json({ release: view(release) });
  });
  router.get("/:version/archive", async (req, res) => {
    try {
      const release = await getRelease(String(req.params.version));
      if (!release) return res.status(404).json({ error: "unknown release", code: "UNKNOWN_RELEASE" });
      const file = await ensureReleaseFile(release);
      const range = byteRange(typeof req.headers.range === "string" ? req.headers.range : undefined, release.size);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("ETag", `"${release.sha256}"`);
      res.setHeader("Peon-Content-Sha256", release.sha256);
      res.setHeader("Content-Type", "application/gzip");
      res.setHeader("Content-Disposition", `attachment; filename="peon-${release.version}.tar.gz"`);
      if (range === "invalid") {
        res.setHeader("Content-Range", `bytes */${release.size}`);
        return res.sendStatus(416);
      }
      if (range) {
        res.status(206);
        res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${release.size}`);
        res.setHeader("Content-Length", range.end - range.start + 1);
        const stream = createReadStream(file, range);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      } else {
        res.setHeader("Content-Length", release.size);
        const stream = createReadStream(file);
        stream.on("error", () => res.destroy());
        stream.pipe(res);
      }
    } catch (error) {
      sendError(error, res);
    }
  });
  return router;
}
