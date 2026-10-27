import { CODEX_OUTCOME_SCHEMA } from "../sessions/index.js";
import { settings } from "../settings/index.js";
import { getCodexQuota } from "../providers/providerQuota.js";
import { getCodexCapabilities } from "../providers/providerCapabilities.js";
import { createCodexLoginRouter } from "./codexLoginRoutes.js";
import {
  codexAppServerHealth,
  forkCodexAppServerThread,
  getCodexAppServerRuntime,
  reconcileCodexAppServerTurn,
  runCodexAppServer,
  shutdownCodexAppServerRuntime,
} from "./codexAppServer.js";
import { CodexLoginService } from "./codexLogin.js";
import { createSelfUpdatingCliUpdater } from "./cliUpdater.js";
import { createCodexModelCatalogService } from "./modelDiscovery.js";
import { canonicalStored, normalizeOutcome, type AgentDriver } from "./registry.js";

const login = new CodexLoginService({ command: () => settings.get().codexCommand || "codex" });

export const codexAppServerDriver: AgentDriver = {
  id: "codex-app-server", serviceProvider: "codex", label: "Codex", available: () => true, visible: true, models: [],
  canonicalModel: () => undefined,
  reasoningEffort: () => undefined,
  command: (current) => current.codexCommand,
  conversation: { initialBackendId: () => null, recoverBackendId: (_id, persisted) => persisted },
  outcomeSchema: (expects) => expects ? CODEX_OUTCOME_SCHEMA : undefined,
  normalizeOutcome: (value) => normalizeOutcome(value, true),
  normalizeStoredEvent: canonicalStored,
  run: runCodexAppServer,
  steer: (run, input, callbacks) => {
    const attempt = run.steer?.(input);
    if (!attempt) return false;
    void attempt.then(callbacks.accepted, callbacks.rejected);
    return true;
  },
  reconcile: reconcileCodexAppServerTurn,
  forkConversation: forkCodexAppServerThread,
  interrupt: (run) => run.kill(), shutdown: (run) => run.kill(),
  shutdownRuntime: async () => { await Promise.all([shutdownCodexAppServerRuntime(), login.shutdown()]); },
  auth: { observeSuccess() {}, observeFailure() {} },
  tokenUsage: { cacheIncludedInInput: true },
  capabilities: { steering: true, cancellation: true, recovery: true, quota: true, status: true, cliUpdate: true, branching: true, branchAtTurn: true, login: true, logout: true },
  services: {
    status: () => codexAppServerHealth(), quota: getCodexQuota,
    capabilities: getCodexCapabilities,
    modelCatalog: createCodexModelCatalogService(getCodexAppServerRuntime),
    loginRouter: (actor) => createCodexLoginRouter(() => login, actor),
    cliUpdate: createSelfUpdatingCliUpdater({ packageName: "@openai/codex", versionPattern: /\bcodex(?:-cli)?\b/i }),
  },
};
