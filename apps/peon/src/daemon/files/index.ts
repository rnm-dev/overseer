import { FileAccessService } from "./service.js";
import type {
  FileAccessContract,
  FileAccessServiceOptions,
  FileEntry,
  FileView,
  FilesystemError,
} from "./contracts.js";
import { MAX_VIEW_BYTES } from "./contracts.js";

export {
  MAX_VIEW_BYTES,
  FileAccessService,
};
export {
  type FileAccessContract,
  type FileAccessServiceOptions,
  type FileEntry,
  type FileSystemBackend,
  type FileView,
  type FilesystemError,
} from "./contracts.js";

const sharedFileAccessService = new FileAccessService();

export function resolveWithinDir(baseDir: string, subpath: string): string | null {
  return sharedFileAccessService.resolveWithinDir(baseDir, subpath);
}

export function resolveFromDir(baseDir: string, subpath: string): string {
  return sharedFileAccessService.resolveFromDir(baseDir, subpath);
}

export function workspaceRelativePath(baseDir: string, absPath: string): string {
  return sharedFileAccessService.workspaceRelativePath(baseDir, absPath);
}

export function listDirEntries(baseDir: string, absDir: string): FileEntry[] {
  return sharedFileAccessService.listDirEntries(baseDir, absDir);
}

export function readFileView(absPath: string): FileView {
  return sharedFileAccessService.readFileView(absPath);
}

export function dirErrorResponse(error: unknown): FilesystemError {
  return sharedFileAccessService.dirErrorResponse(error);
}

export function fileErrorResponse(error: unknown): FilesystemError {
  return sharedFileAccessService.fileErrorResponse(error);
}
