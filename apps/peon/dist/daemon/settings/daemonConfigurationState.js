import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { writePrivateFileDurably, ensurePrivateDirectory, secureExistingPrivateFile } from "../runtime/durablePrivateFile.js";
import { stateDir } from "../runtime/xdgPaths.js";
import { settings } from "./settingsService.js";
export const DAEMON_CONFIGURATION_SCHEMA_VERSION = 1;
function canonical(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
export function daemonConfigurationDigest(values) {
    return createHash("sha256").update(canonical(values)).digest("hex");
}
function valid(value) {
    const item = value;
    return Boolean(item) && item.version === 1 && item.schemaVersion === 1
        && typeof item.epoch === "string" && item.epoch.length > 0
        && Number.isSafeInteger(item.revision) && item.revision >= 0
        && typeof item.digest === "string" && /^[a-f0-9]{64}$/.test(item.digest)
        && Number.isSafeInteger(item.updatedAt) && item.updatedAt >= 0;
}
export class DaemonConfigurationState {
    filePath;
    now;
    configuration;
    identity;
    constructor(filePath = path.join(stateDir(), "daemon-settings-revision-v1.json"), now = Date.now, configuration = settings) {
        this.filePath = filePath;
        this.now = now;
        this.configuration = configuration;
        this.identity = this.load();
        this.reconcile();
    }
    snapshot() {
        const values = this.configuration.getDaemonConfigurationView();
        return { ...this.identity, values };
    }
    reconcile() {
        const values = this.configuration.getDaemonConfigurationView();
        const digest = daemonConfigurationDigest(values);
        if (digest === this.identity.digest)
            return { changed: false, snapshot: { ...this.identity, values } };
        const next = {
            ...this.identity,
            revision: this.identity.revision + 1,
            digest,
            updatedAt: this.now(),
        };
        this.persist(next);
        this.identity = next;
        return { changed: true, snapshot: { ...next, values } };
    }
    load() {
        secureExistingPrivateFile(this.filePath);
        try {
            if (existsSync(this.filePath)) {
                const parsed = JSON.parse(readFileSync(this.filePath, "utf8"));
                if (valid(parsed))
                    return parsed;
            }
        }
        catch {
            // A corrupt identity is reset to a new epoch; settings remain authoritative.
        }
        const values = this.configuration.getDaemonConfigurationView();
        const initial = {
            version: 1,
            epoch: randomUUID(),
            revision: 0,
            schemaVersion: 1,
            digest: daemonConfigurationDigest(values),
            updatedAt: this.now(),
        };
        this.persist(initial);
        return initial;
    }
    persist(value) {
        ensurePrivateDirectory(path.dirname(this.filePath));
        writePrivateFileDurably(this.filePath, JSON.stringify(value, null, 2));
    }
}
