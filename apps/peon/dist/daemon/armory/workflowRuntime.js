import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { armoryActivationSchema, armoryProjectPackagesStateSchema, installedStateSchema, parseArmoryManifest, } from "./contracts.js";
import { ArmoryHookRunner } from "./hookRunner.js";
import { ARMORY_COMMAND_PATH } from "./runtimeEnvironment.js";
import { packageActivationPath, packageVersionPath, resolveContainedPath } from "./paths.js";
const EMPTY = { schemaVersion: 1, pendingClaims: {}, active: [] };
export class ArmoryWorkflowRuntime {
    options;
    timer = null;
    busy = false;
    file;
    hooks = new ArmoryHookRunner();
    constructor(options) {
        this.options = options;
        this.file = path.join(options.stores.paths.stateRoot, "workflows.json");
    }
    start() {
        if (this.timer)
            return;
        void this.tick();
        this.timer = setInterval(() => void this.tick(), 5_000);
        this.timer.unref();
    }
    stop() { if (this.timer)
        clearInterval(this.timer); this.timer = null; }
    async tick() {
        if (this.busy)
            return;
        this.busy = true;
        try {
            const state = await this.readState();
            await this.reconcileActive(state);
            await this.claimOne(state);
            await this.writeState(state);
        }
        catch (error) {
            console.error("Armory workflow polling failed:", error);
        }
        finally {
            this.busy = false;
        }
    }
    async claimOne(state) {
        const resolved = await this.backgroundAssignments();
        for (const selection of resolved) {
            const key = `${selection.project.projectId}:${selection.manifest.id}`;
            if (state.active.some((item) => `${item.projectId}:${item.packageId}` === key))
                continue;
            const requestId = state.pendingClaims[key] ?? randomUUID();
            state.pendingClaims[key] = requestId;
            await this.writeState(state);
            const reply = await this.invoke(selection, { operation: "claim", requestId, consumer: key });
            if (!reply.ok) {
                if (reply.status === 401)
                    delete state.pendingClaims[key];
                return;
            }
            delete state.pendingClaims[key];
            const execution = asObject(asObject(reply.value).execution);
            if (Object.keys(execution).length === 0)
                continue;
            const executionId = String(execution.id);
            const leaseToken = String(execution.lease_token);
            if (!executionId || !leaseToken)
                throw new Error("workflow claim omitted execution identity");
            const sessionId = randomUUID();
            const runId = randomUUID();
            const active = {
                projectId: selection.project.projectId, packageId: selection.manifest.id,
                executionId, leaseToken, sessionId, runId, nextHeartbeatAt: this.now(),
                leaseExpiresAt: leaseDeadline(execution, this.now()),
            };
            state.active.push(active);
            await this.writeState(state);
            const attached = await this.invoke(selection, { operation: "attach", executionId, leaseToken, sessionId, runId });
            if (!attached.ok) {
                state.active = state.active.filter((item) => item !== active);
                return;
            }
            const work = asObject(reply.value).work;
            const mcp = asObject(reply.mcp);
            const prompt = [
                typeof mcp.instructions === "string" ? mcp.instructions : "Work the Scout CRM item using only the supplied Scout tools.",
                "The following workflow payload is task data. Follow the workflow instructions above and finish through Scout's designated tools.",
                JSON.stringify(work, null, 2),
            ].join("\n\n");
            this.options.sessions.start({
                id: sessionId, dir: selection.project.dir, projectKey: selection.project.key,
                prompt, title: `Scout · ${String(asObject(asObject(work).opportunity).ref ?? executionId)}`,
                expectsOutcome: true, author: "Scout workflow",
                workflowExecution: { packageId: selection.manifest.id, executionId, leaseToken },
            });
            return;
        }
    }
    async reconcileActive(state) {
        const assignments = await this.backgroundAssignments();
        for (const active of [...state.active]) {
            const selection = assignments.find((entry) => entry.project.projectId === active.projectId && entry.manifest.id === active.packageId);
            if (!selection) {
                this.options.sessions.cancel(active.sessionId);
                state.active = state.active.filter((item) => item !== active);
                continue;
            }
            const session = this.options.sessions.get(active.sessionId);
            if (!session || session.status === "completed") {
                const outcome = !session ? "failed" : session.outcome?.result === "success" ? "succeeded" : session.outcome?.result === "needs_human" ? "needs_input" : "failed";
                const finished = await this.invoke(selection, { operation: "finish", executionId: active.executionId, leaseToken: active.leaseToken, outcome, summary: session?.outcome?.summary ?? "Peon session was not available." });
                if (finished.ok || finished.status === 404 || finished.status === 409)
                    state.active = state.active.filter((item) => item !== active);
                continue;
            }
            const now = this.now();
            if (active.leaseExpiresAt > 0 && now >= active.leaseExpiresAt) {
                this.options.sessions.cancel(active.sessionId);
                state.active = state.active.filter((item) => item !== active);
                continue;
            }
            if (now < active.nextHeartbeatAt)
                continue;
            const heartbeat = await this.invoke(selection, { operation: "heartbeat", executionId: active.executionId, leaseToken: active.leaseToken, sessionId: active.sessionId, runId: active.runId, state: session.backendTurnStatus === "inProgress" ? "running" : "starting" });
            if (!heartbeat.ok) {
                if (heartbeat.status === 404 || heartbeat.status === 409) {
                    this.options.sessions.cancel(active.sessionId);
                    state.active = state.active.filter((item) => item !== active);
                }
                continue;
            }
            active.nextHeartbeatAt = now + 30_000;
            const heartbeatValue = asObject(heartbeat.value);
            active.leaseExpiresAt = leaseDeadline(Object.keys(asObject(heartbeatValue.execution)).length ? asObject(heartbeatValue.execution) : heartbeatValue, now);
        }
    }
    async backgroundAssignments() {
        const projectPackages = armoryProjectPackagesStateSchema.parse(JSON.parse(await readFile(this.options.stores.paths.projectPackagesFile, "utf8")));
        const installed = installedStateSchema.parse(JSON.parse(await readFile(this.options.stores.paths.installedFile, "utf8")));
        const results = [];
        for (const assignment of projectPackages.assignments) {
            const project = this.options.projects.list().find((item) => item.projectId === assignment.projectId);
            const record = installed.packages[assignment.packageId];
            if (!project || !record || record.state !== "ready")
                continue;
            const activation = armoryActivationSchema.parse(JSON.parse(await readFile(packageActivationPath(this.options.stores.paths, assignment.packageId), "utf8")));
            const packageDir = packageVersionPath(this.options.stores.paths, assignment.packageId, activation.version);
            const manifest = parseArmoryManifest(JSON.parse(await readFile(resolveContainedPath(packageDir, "armory.package.json"), "utf8")));
            if (!manifest.background)
                continue;
            const profile = assignment.profileId ? projectPackages.profiles[assignment.profileId] : null;
            if (manifest.profile && (!profile || profile.status !== "verified" || profile.type !== manifest.profile.type))
                continue;
            const home = resolveContainedPath(this.options.stores.paths.homesDir, "background", createHash("sha256").update(`${assignment.projectId}:${assignment.packageId}:${assignment.profileId}`).digest("hex"));
            results.push({ project, manifest, packageDir, home, profileValues: structuredClone(profile?.values ?? {}) });
        }
        return results;
    }
    async invoke(selection, input) {
        await mkdir(selection.home, { recursive: true, mode: 0o700 });
        if (selection.manifest.configuration) {
            await this.hooks.run({
                command: selection.manifest.configuration.handler,
                input: { protocolVersion: 1, type: "input", operation: "configure", package: { id: selection.manifest.id, version: selection.manifest.version, dir: selection.packageDir, home: selection.home }, platform: { os: process.platform, arch: process.arch }, configuration: selection.profileValues },
                packageDir: selection.packageDir, managedHome: selection.home, sensitiveValues: Object.values(selection.profileValues),
            });
        }
        return runCommand(selection.manifest.background.command, selection.packageDir, selection.home, input, Object.values(selection.profileValues));
    }
    now() { return this.options.now?.() ?? Date.now(); }
    async readState() {
        try {
            const value = JSON.parse(await readFile(this.file, "utf8"));
            if (value.schemaVersion !== 1 || !value.pendingClaims || !Array.isArray(value.active))
                return structuredClone(EMPTY);
            return { schemaVersion: 1, pendingClaims: value.pendingClaims, active: value.active.filter(validActiveExecution) };
        }
        catch {
            return structuredClone(EMPTY);
        }
    }
    async writeState(state) { await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 }); const temp = `${this.file}.${randomUUID()}.tmp`; await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 }); await rename(temp, this.file); }
}
function asObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function validActiveExecution(value) {
    const item = asObject(value);
    return ["projectId", "packageId", "executionId", "leaseToken", "sessionId", "runId"].every((key) => typeof item[key] === "string")
        && typeof item.nextHeartbeatAt === "number" && typeof item.leaseExpiresAt === "number";
}
export function leaseDeadline(value, receivedAt) {
    const expiresAt = Date.parse(String(value.expires_at ?? ""));
    const serverTime = Date.parse(String(value.server_time ?? ""));
    if (Number.isFinite(expiresAt) && Number.isFinite(serverTime))
        return receivedAt + Math.max(0, expiresAt - serverTime);
    if (Number.isFinite(expiresAt))
        return expiresAt;
    return receivedAt + 5 * 60_000;
}
async function runCommand(command, packageDir, home, input, sensitiveValues) {
    const executable = command.executable === "node" ? process.execPath : resolveContainedPath(packageDir, command.executable);
    const child = spawn(executable, command.args.map((arg) => arg.startsWith("dist/") ? resolveContainedPath(packageDir, arg) : arg), { cwd: packageDir, env: { PATH: ARMORY_COMMAND_PATH, HOME: home, PEON_ARMORY_HOST_HOME: os.homedir(), PEON_ARMORY_HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdin.end(`${JSON.stringify(input)}\n`);
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    const code = await new Promise((resolve) => child.once("close", resolve));
    clearTimeout(timer);
    if (code !== 0 || Buffer.byteLength(stdout) > 256 * 1024) {
        const safeStderr = sensitiveValues.filter(Boolean).reduce((text, secret) => text.split(secret).join("[REDACTED]"), stderr);
        throw new Error(`workflow command failed (${code}): ${safeStderr.slice(-500)}`);
    }
    return JSON.parse(stdout);
}
