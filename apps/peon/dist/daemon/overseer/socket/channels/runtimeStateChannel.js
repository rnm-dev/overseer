import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { settings } from "../../../settings/index.js";
import { sessions } from "../../../sessions/index.js";
import { listAgentDrivers } from "../../../agents/index.js";
import { modelCatalog } from "../../../providers/modelCatalog.js";
export const RUNTIME_STATE_CAPABILITY = "runtime-state-v1";
const MAX_RUNTIME_STATE_BYTES = 56 * 1024;
const FORBIDDEN_RUNTIME_KEY = /(?:credential|secret|token|password|authorization|authresponse|environment|executablepath|filetransferroot)/i;
function packageVersion() {
    try {
        const path = fileURLToPath(new URL("../../../../../package.json", import.meta.url));
        return String(JSON.parse(readFileSync(path, "utf8")).version ?? "unknown");
    }
    catch {
        return "unknown";
    }
}
function canonical(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    const record = value;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function hasForbiddenRuntimeKey(value, seen = new Set()) {
    if (!value || typeof value !== "object")
        return false;
    if (seen.has(value))
        return true;
    seen.add(value);
    if (Array.isArray(value))
        return value.some((item) => hasForbiddenRuntimeKey(item, seen));
    return Object.entries(value).some(([key, nested]) => FORBIDDEN_RUNTIME_KEY.test(key) || hasForbiddenRuntimeKey(nested, seen));
}
export class RuntimeStateChannel {
    readState;
    subscribe;
    capability = RUNTIME_STATE_CAPABILITY;
    epoch = randomUUID();
    revision = 0;
    digest = "";
    sender = null;
    accepted = false;
    unsubscribe = null;
    constructor(readState = () => RuntimeStateChannel.defaultState(), subscribe = (listener) => {
        settings.on("change", listener);
        sessions.on("change", listener);
        return () => {
            settings.off("change", listener);
            sessions.off("change", listener);
        };
    }) {
        this.readState = readState;
        this.subscribe = subscribe;
    }
    helloState() {
        return { protocol: 1, epoch: this.epoch, revision: this.revision, digest: this.digest || null };
    }
    started(sender) {
        this.accepted = false;
        this.sender = null;
        this.unsubscribe ??= this.subscribe(() => this.publish());
    }
    connecting() { }
    negotiated(accepted, _ack, sender) {
        if (accepted && !sender.durable)
            return sender.disconnect("runtime state requires durable-delivery-v1");
        this.accepted = accepted && sender.durable;
        this.sender = this.accepted ? sender : null;
        if (accepted)
            this.publish(true);
    }
    disconnected(resetAuthority) {
        if (resetAuthority) {
            this.accepted = false;
            this.sender = null;
        }
    }
    handles() { return false; }
    receive() { }
    static defaultState() {
        const current = settings.get();
        const providers = listAgentDrivers({ visible: true }).map((driver) => ({
            id: driver.id,
            available: driver.available(),
            capabilities: { ...driver.capabilities },
        }));
        return {
            name: current.name || null,
            paused: current.paused,
            filesEnabled: Boolean(current.fileTransferRoot),
            capacity: { active: sessions.activeCount(), total: sessions.list().length },
            daemon: { version: packageVersion(), revision: process.env.PEON_REVISION?.slice(0, 80) ?? null },
            defaultAgent: current.defaultAgent,
            providers,
            models: modelCatalog(current.defaultAgent, current.ai.defaultModel, current.ai.defaultReasoningEffort),
        };
    }
    publish(force = false) {
        const sender = this.sender;
        if (!this.accepted || !sender?.durable)
            return;
        const liveState = this.readState();
        if (hasForbiddenRuntimeKey(liveState)) {
            sender.disconnect("runtime state contains a forbidden sensitive key");
            return;
        }
        let state;
        let serialized;
        try {
            serialized = JSON.stringify(liveState);
            state = JSON.parse(serialized);
        }
        catch {
            sender.disconnect("runtime state is not JSON serializable");
            return;
        }
        if (Buffer.byteLength(serialized, "utf8") > MAX_RUNTIME_STATE_BYTES) {
            sender.disconnect("runtime state exceeds the negotiated payload bound");
            return;
        }
        const encoded = canonical(state);
        const digest = createHash("sha256").update(encoded).digest("hex");
        if (!force && digest === this.digest)
            return;
        if (digest !== this.digest)
            this.revision += 1;
        this.digest = digest;
        sender.sendDurable({
            type: "runtime_state",
            protocol: 1,
            epoch: this.epoch,
            revision: this.revision,
            digest,
            generatedAt: Date.now(),
            state,
        }, {
            capability: this.capability,
            priority: "normal",
            dedupeKey: `runtime-state:${this.epoch}:${this.revision}`,
            coalesceKey: "runtime-state",
        });
    }
}
