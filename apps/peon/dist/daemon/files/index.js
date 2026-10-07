import { FileAccessService } from "./service.js";
import { MAX_VIEW_BYTES } from "./contracts.js";
export { MAX_VIEW_BYTES, FileAccessService, };
export { ATTACHMENT_UPLOAD_MAX_BYTES, AtomicFileUpload, deleteProjectFile, FileWriteError, PROJECT_UPLOAD_MAX_BYTES, fileWriteFsError, moveProjectFile, projectFileWriteTarget, revalidateFileWriteTarget, sandboxFileWriteTarget, } from "./writes.js";
const sharedFileAccessService = new FileAccessService();
export function resolveWithinDir(baseDir, subpath) {
    return sharedFileAccessService.resolveWithinDir(baseDir, subpath);
}
export function resolveFromDir(baseDir, subpath) {
    return sharedFileAccessService.resolveFromDir(baseDir, subpath);
}
export function workspaceRelativePath(baseDir, absPath) {
    return sharedFileAccessService.workspaceRelativePath(baseDir, absPath);
}
export function listDirEntries(baseDir, absDir) {
    return sharedFileAccessService.listDirEntries(baseDir, absDir);
}
export function readFileView(absPath) {
    return sharedFileAccessService.readFileView(absPath);
}
export function dirErrorResponse(error) {
    return sharedFileAccessService.dirErrorResponse(error);
}
export function fileErrorResponse(error) {
    return sharedFileAccessService.fileErrorResponse(error);
}
export { DirectoryWatchRegistry, directoryWatchTarget } from "./directoryWatch.js";
