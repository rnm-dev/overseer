import { storedTimestampMetadata, OUTCOME_SCHEMA } from "../sessions/index.js";
import { settings } from "../settings/index.js";
import { claudeCodeAuth } from "../providers/claudeCodeAuth.js";
import { getClaudeQuota } from "../providers/providerQuota.js";
import { getClaudeCapabilities } from "../providers/providerCapabilities.js";
import { createClaudeLoginRouter } from "./claudeLoginRoutes.js";
import { forkClaudeCodeSession, normalizeClaudeCodeEvent, runClaudeCode } from "./claudeCode.js";
import { ClaudeLoginService } from "./claudeLogin.js";
import { createSelfUpdatingCliUpdater } from "./cliUpdater.js";
import { claudeModelCatalogService } from "./modelDiscovery.js";
import { canonicalStored, normalizeOutcome, previewEvent } from "./registry.js";
const login = new ClaudeLoginService({
    command: () => settings.get().agentCommand || "claude",
    onSuccess: () => { claudeCodeAuth.clearObservedFailure(); void claudeCodeAuth.refresh(); },
    onLogout: () => { void claudeCodeAuth.refresh(); },
});
export const claudeCodeDriver = {
    id: "claude-code", label: "Claude Code", available: () => true, visible: true, models: [],
    canonicalModel: () => undefined,
    reasoningEffort: () => undefined,
    command: (current) => current.agentCommand,
    conversation: { initialBackendId: (id) => id, recoverBackendId: (id, persisted) => persisted ?? id },
    outcomeSchema: (expects) => expects ? OUTCOME_SCHEMA : undefined, normalizeOutcome: (value) => normalizeOutcome(value, false),
    normalizeStoredEvent(raw) {
        // Provider normalization must not reinterpret persisted accounting or strip
        // harness-owned invocation identity when replaying after restart/branch.
        if (raw.type === "result" || (raw.type === "system" && raw.subtype === "usage"))
            return canonicalStored(raw);
        const common = previewEvent(raw);
        const event = common ?? normalizeClaudeCodeEvent(raw);
        return event ? { ...event, ...storedTimestampMetadata(raw) } : null;
    },
    run: runClaudeCode,
    forkConversation: forkClaudeCodeSession,
    interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
    startRuntime: () => claudeCodeAuth.start(),
    shutdownRuntime: () => login.shutdown(),
    auth: {
        observeSuccess: () => claudeCodeAuth.clearObservedFailure(),
        observeFailure: (message) => { if (claudeCodeAuth.isLikelyAuthFailure(message))
            claudeCodeAuth.recordPossibleAuthFailure(message, Date.now()); },
    },
    // Claude Code can dequeue the supplied -p prompt in the same startup batch
    // as an orphaned background-task notification and terminate the resumed
    // invocation without handling the prompt.
    turns: { replayUnprocessedResume: true },
    tokenUsage: { cacheIncludedInInput: false },
    capabilities: { steering: false, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: true, branching: true, branchAtTurn: false, login: true, logout: true },
    services: {
        status: () => claudeCodeAuth.getState(),
        authStatus: () => {
            const state = claudeCodeAuth.getState();
            return { authState: state.authState, available: state.available, checkedAt: state.checkedAt };
        },
        quota: getClaudeQuota,
        capabilities: getClaudeCapabilities,
        modelCatalog: claudeModelCatalogService,
        loginRouter: (actor) => createClaudeLoginRouter(() => login, actor),
        cliUpdate: createSelfUpdatingCliUpdater({
            packageName: "@anthropic-ai/claude-code",
            versionPattern: /\bClaude Code\b/i,
            nativePathFragments: ["/.local/share/claude/versions/"],
        }),
    },
};
