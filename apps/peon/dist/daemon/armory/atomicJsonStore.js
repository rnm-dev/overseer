import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
const updateTails = new Map();
export class ArmoryStorageError extends Error {
    code;
    filePath;
    constructor(code, filePath, message, options) {
        super(message, options);
        this.code = code;
        this.filePath = filePath;
        this.name = "ArmoryStorageError";
    }
}
export class AtomicJsonStore {
    filePath;
    schema;
    defaults;
    mode;
    constructor(options) {
        this.filePath = options.filePath;
        this.schema = options.schema;
        this.defaults = options.defaults;
        this.mode = options.mode ?? 0o600;
    }
    async read() {
        let raw;
        try {
            raw = await readFile(this.filePath, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT")
                return structuredClone(this.defaults());
            throw new ArmoryStorageError("STATE_READ_FAILED", this.filePath, `Unable to read Armory state at ${this.filePath}`, { cause: error });
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (error) {
            throw new ArmoryStorageError("MALFORMED_STATE", this.filePath, `Armory state contains malformed JSON: ${this.filePath}`, { cause: error });
        }
        const result = this.schema.safeParse(parsed);
        if (!result.success) {
            throw new ArmoryStorageError("INVALID_STATE", this.filePath, `Armory state failed validation: ${this.filePath}: ${result.error.issues[0]?.message ?? "unknown validation error"}`);
        }
        return result.data;
    }
    async write(value) {
        const result = this.schema.safeParse(value);
        if (!result.success) {
            throw new ArmoryStorageError("INVALID_STATE", this.filePath, `Refusing to persist invalid Armory state: ${result.error.issues[0]?.message ?? "unknown validation error"}`);
        }
        await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
        const temporary = path.join(path.dirname(this.filePath), `.${path.basename(this.filePath)}.${randomUUID()}.tmp`);
        let handle = null;
        try {
            handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, this.mode);
            await handle.writeFile(`${JSON.stringify(result.data, null, 2)}\n`, "utf8");
            await handle.sync();
            await handle.close();
            handle = null;
            await chmod(temporary, this.mode);
            await rename(temporary, this.filePath);
            await syncDirectory(path.dirname(this.filePath));
        }
        catch (error) {
            await handle?.close().catch(() => undefined);
            await rm(temporary, { force: true }).catch(() => undefined);
            if (error instanceof ArmoryStorageError)
                throw error;
            throw new ArmoryStorageError("STATE_WRITE_FAILED", this.filePath, `Unable to atomically write Armory state: ${this.filePath}`, { cause: error });
        }
    }
    update(mutator) {
        const key = path.resolve(this.filePath);
        const previous = updateTails.get(key) ?? Promise.resolve();
        const operation = previous.then(async () => {
            const current = await this.read();
            const next = await mutator(structuredClone(current));
            await this.write(next);
            return next;
        });
        const tail = operation.then(() => undefined, () => undefined);
        updateTails.set(key, tail);
        void tail.finally(() => {
            if (updateTails.get(key) === tail)
                updateTails.delete(key);
        });
        return operation;
    }
}
/** Flushes directory-entry changes such as rename and unlink to durable storage. */
export async function syncDirectory(directory) {
    // Node does not expose a flushable directory handle on Windows. File data is
    // synced before the atomic rename; skip only the unsupported directory flush.
    if (process.platform === "win32")
        return;
    const handle = await open(directory, constants.O_RDONLY);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
