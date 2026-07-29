import type { Dirent, Stats } from "node:fs";

export interface FileEntry {
  name: string;
  type: "dir" | "file" | "other";
  size: number | null;
  mtimeMs: number | null;
}

export const MAX_VIEW_BYTES = 2 * 1024 * 1024;

export interface FileView {
  size: number;
  mtimeMs: number;
  binary: boolean;
  truncated: boolean;
  content: string | null;
}

export interface FilesystemError {
  status: number;
  message: string;
}

export interface FileSystemBackend {
  closeSync: (fd: number) => void;
  openSync: (path: string, flags: string, mode?: number) => number;
  readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  readdirSync: (path: string, options: { withFileTypes: true }) => Array<Pick<Dirent, "name" | "isDirectory" | "isFile" | "isSymbolicLink">>;
  realpathSync: (path: string) => string;
  statSync: (path: string) => Stats;
}

export interface FileAccessContract {
  resolveWithinDir(baseDir: string, subpath: string): string | null;
  resolveFromDir(baseDir: string, subpath: string): string;
  workspaceRelativePath(baseDir: string, absPath: string): string;
  listDirEntries(baseDir: string, absDir: string): FileEntry[];
  readFileView(absPath: string): FileView;
  dirErrorResponse(error: unknown): FilesystemError;
  fileErrorResponse(error: unknown): FilesystemError;
}

export interface FileAccessServiceOptions {
  fileSystem?: Partial<FileSystemBackend>;
}
