import os from "node:os";
import { CODEX_OUTCOME_SCHEMA } from "../sessions/index.js";
import { settings } from "../settings/index.js";
import { createSelfUpdatingCliUpdater } from "./cliUpdater.js";
import { discoverOpencodeModels, forkOpencodeSession, runOpencode } from "./opencode.js";
import { createOpencodeLoginRouter, OpencodeLoginError } from "./opencodeLoginRoutes.js";
import { withOpencodeServer } from "./opencodeServer.js";
import { fetchOpenrouterKeyInfo, getOpenrouterQuota, openrouterApiKey, openrouterAuth, OpenrouterKeyError } from "./openrouter.js";
import { canonicalStored, normalizeOutcome } from "./registry.js";
const ID = "opencode";
const command = () => settings.get().opencodeCommand || "opencode";
let commandAvailable = true;
let refreshTimer = null;
const REFRESH_INTERVAL_MS = 15 * 60_000;
const login = {
    status() {
        const state = openrouterAuth.status(commandAvailable);
        return { loggedIn: state.keySource !== null, keySource: state.keySource, keyHint: state.keyHint, authState: state.authState, error: state.error };
    },
    async setApiKey(apiKey) {
        try {
            await fetchOpenrouterKeyInfo(apiKey);
        }
        catch (error) {
            if (error instanceof OpenrouterKeyError && (error.status === 401 || error.status === 403)) {
                throw new OpencodeLoginError(400, "INVALID_API_KEY", "OpenRouter rejected this API key");
            }
            throw new OpencodeLoginError(502, "OPENROUTER_UNREACHABLE", error instanceof Error ? error.message : "OpenRouter is unreachable");
        }
        // Store it where opencode keeps credentials, through opencode's own API.
        await withOpencodeServer({ command: command(), cwd: os.tmpdir() }, (server) => server.request("PUT", "/auth/openrouter", { body: { type: "api", key: apiKey } }));
        await openrouterAuth.refresh();
    },
    async clearApiKey() {
        if (openrouterApiKey()?.source === "env") {
            throw new OpencodeLoginError(409, "KEY_FROM_ENVIRONMENT", "The OpenRouter key comes from OPENROUTER_API_KEY in Peon's environment; remove it there");
        }
        await withOpencodeServer({ command: command(), cwd: os.tmpdir() }, (server) => server.request("DELETE", "/auth/openrouter"));
        await openrouterAuth.refresh();
    },
};
export const opencodeDriver = {
    id: ID, label: "OpenCode", available: () => true, visible: true, models: [],
    canonicalModel: () => undefined,
    reasoningEffort: () => undefined,
    command: (current) => current.opencodeCommand || "opencode",
    conversation: { initialBackendId: () => null, recoverBackendId: (_id, persisted) => persisted },
    outcomeSchema: (expects) => expects ? CODEX_OUTCOME_SCHEMA : undefined,
    normalizeOutcome: (value) => normalizeOutcome(value, true),
    normalizeStoredEvent: canonicalStored,
    run: runOpencode,
    forkConversation: ({ command: cmd, backendSessionId, cwd }) => forkOpencodeSession({ command: cmd, backendSessionId, cwd }),
    interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
    startRuntime() {
        void openrouterAuth.refresh();
        refreshTimer = setInterval(() => { void openrouterAuth.refresh(); }, REFRESH_INTERVAL_MS);
        refreshTimer.unref?.();
    },
    shutdownRuntime() {
        if (refreshTimer)
            clearInterval(refreshTimer);
        refreshTimer = null;
    },
    auth: {
        observeSuccess: () => openrouterAuth.observeSuccess(),
        observeFailure: (message) => {
            if (/opencode is unavailable/i.test(message))
                commandAvailable = false;
            openrouterAuth.observeFailure(message);
        },
    },
    tokenUsage: { cacheIncludedInInput: false },
    capabilities: { steering: false, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: true, branching: true, branchAtTurn: false, login: true, logout: true, loginKind: "api-key" },
    services: {
        status: () => openrouterAuth.status(commandAvailable),
        authStatus: () => {
            const { authState, available, checkedAt } = openrouterAuth.status(commandAvailable);
            return { authState, available, checkedAt };
        },
        quota: () => getOpenrouterQuota(ID),
        modelCatalog: { discover: discoverOpencodeModels },
        loginRouter: (actor) => createOpencodeLoginRouter(() => login, actor),
        cliUpdate: createSelfUpdatingCliUpdater({ packageName: "opencode-ai", versionPattern: /^\s*v?\d+\.\d+\.\d+/, updateArgs: ["upgrade"] }),
    },
};
