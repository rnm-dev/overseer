import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import type { Dirent } from "node:fs";
import {
  type FileAccessContract,
  type FileAccessServiceOptions,
  type FileEntry,
  type FileSystemBackend,
  type FileView,
  type FilesystemError,
  MAX_VIEW_BYTES,
} from "./contracts.js";

function defaultFileSystem(): FileSystemBackend {
  return {
    closeSync,
    openSync,
    readSync,
    readdirSync: (pathToRead, options: { withFileTypes: true }) => readdirSync(pathToRead, options),
    realpathSync,
    statSync,
  };
}

function isWithin(baseDir: string, target: string): boolean {
  const rel = path.relative(baseDir, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export class FileAccessService implements FileAccessContract {
  private readonly fileSystem: FileSystemBackend;

  constructor(options: FileAccessServiceOptions = {}) {
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

  resolveWithinDir(baseDir: string, subpath: string): string | null {
    const lexical = path.resolve(baseDir, subpath);
    const lexicalRel = path.relative(path.resolve(baseDir), lexical);
    if (lexicalRel === ".." || lexicalRel.startsWith(`..${path.sep}`) || path.isAbsolute(lexicalRel)) return null;

    const realBase = this.fileSystem.realpathSync(baseDir);
    const realTarget = this.fileSystem.realpathSync(lexical);
    return isWithin(realBase, realTarget) ? realTarget : null;
  }

  resolveFromDir(baseDir: string, subpath: string): string {
    return this.fileSystem.realpathSync(path.resolve(baseDir, subpath));
  }

  workspaceRelativePath(baseDir: string, absPath: string): string {
    return path.relative(this.fileSystem.realpathSync(baseDir), absPath);
  }

  listDirEntries(baseDir: string, absDir: string): FileEntry[] {
    const realBase = this.fileSystem.realpathSync(baseDir);
    const entries: FileEntry[] = readdirEntries(absDir, this.fileSystem, realBase);
    entries.sort((a, b) => {
      if (a.type === "dir" && b.type !== "dir") return -1;
      if (a.type !== "dir" && b.type === "dir") return 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return entries;
  }

  readFileView(absPath: string): FileView {
    const st = this.fileSystem.statSync(absPath);
    if (!st.isFile()) {
      const err: NodeJS.ErrnoException = new Error("not a file");
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
        if (count === 0) break;
        bytesRead += count;
      }
    } finally {
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

  dirErrorResponse(error: unknown): FilesystemError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: 404, message: "directory not found" };
    if (code === "ENOTDIR") return { status: 400, message: "not a directory" };
    if (code === "EACCES") return { status: 403, message: "permission denied" };
    if (code === "EPERM") return { status: 403, message: "permission denied" };
    return { status: 500, message: "failed to read directory" };
  }

  fileErrorResponse(error: unknown): FilesystemError {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { status: 404, message: "file not found" };
    if (code === "EISDIR" || code === "EINVAL") return { status: 400, message: "not a file" };
    if (code === "EACCES") return { status: 403, message: "permission denied" };
    if (code === "EPERM") return { status: 403, message: "permission denied" };
    return { status: 500, message: "failed to read file" };
  }
}

function readdirEntries(absDir: string, fileSystem: FileSystemBackend, realBase: string): FileEntry[] {
  return fileSystem.readdirSync(absDir, { withFileTypes: true }).map((entry) => {
    const candidate = path.join(absDir, entry.name);
    let type: FileEntry["type"] = entry.isDirectory() ? "dir" : entry.isFile() ? "file" : "other";
    let size: number | null = null;
    let mtimeMs: number | null = null;
    try {
      const realTarget = fileSystem.realpathSync(candidate);
      if (!isWithin(realBase, realTarget)) return { name: entry.name, type: "other", size, mtimeMs };
      const st = fileSystem.statSync(realTarget);
      type = st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      size = st.isFile() ? st.size : null;
      mtimeMs = st.mtimeMs;
    } catch {
      type = "other";
    }
    return { name: entry.name, type, size, mtimeMs };
  });
}
