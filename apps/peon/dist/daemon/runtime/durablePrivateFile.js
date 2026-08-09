import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import path from "node:path";
function cleanupTemporary(filePath) {
    try {
        unlinkSync(filePath);
    }
    catch {
        // Best-effort cleanup must never replace the write/rename/fsync failure
        // that determines whether the caller may clear recoverable state.
    }
}
export function ensurePrivateDirectory(directoryPath) {
    mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directoryPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`private storage path is not a directory: ${directoryPath}`);
    }
    chmodSync(directoryPath, 0o700);
    syncDirectory(directoryPath);
}
export function syncDirectory(directoryPath) {
    if (process.platform === "win32")
        return;
    const fd = openSync(directoryPath, "r");
    try {
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
export function secureExistingPrivateFile(filePath) {
    if (!existsSync(filePath))
        return;
    ensurePrivateDirectory(path.dirname(filePath));
    chmodSync(filePath, 0o600);
}
export function writePrivateFileDurably(filePath, contents) {
    const directoryPath = path.dirname(filePath);
    ensurePrivateDirectory(directoryPath);
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd = null;
    try {
        fd = openSync(temporary, "wx", 0o600);
        writeFileSync(fd, contents);
        fsyncSync(fd);
        closeSync(fd);
        fd = null;
        renameSync(temporary, filePath);
        chmodSync(filePath, 0o600);
        syncDirectory(directoryPath);
    }
    catch (error) {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch {
                // Preserve the primary persistence failure.
            }
        }
        cleanupTemporary(temporary);
        throw error;
    }
}
