import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { stateDir } from "../xdgPaths.js";
import { secureExistingPrivateFile, writePrivateFileDurably, } from "../durablePrivateFile.js";
export const EMPTY_ENROLLMENT_STATE = { version: 1 };
function clone(value) {
    return structuredClone(value);
}
export class EnrollmentStateStore {
    filePath;
    current;
    constructor(filePath = path.join(stateDir(), "enrollment-v1.json")) {
        this.filePath = filePath;
        this.current = this.read();
    }
    get() {
        return clone(this.current);
    }
    replace(next) {
        if (next.version !== 1)
            throw new Error("unsupported enrollment state version");
        writePrivateFileDurably(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
        this.current = clone(next);
        return this.get();
    }
    update(mutator) {
        return this.replace(mutator(this.get()));
    }
    read() {
        if (!existsSync(this.filePath))
            return clone(EMPTY_ENROLLMENT_STATE);
        secureExistingPrivateFile(this.filePath);
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
        if (!parsed || parsed.version !== 1)
            throw new Error("invalid enrollment state");
        return parsed;
    }
}
