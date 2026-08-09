import { modelCatalog } from "../providers/modelCatalog.js";
import { cliUpdates } from "../updates/cliUpdates.js";
import { createArmoryStores, ArmoryConfigurationService, ArmoryMcpLifecycleService, ArmoryMcpRuntime, ArmoryPackageInstallService, ArmoryProjectPackagesService, ArmoryUninstallService, armoryInventory } from "../armory/index.js";
import { createProjectService, projectStore } from "../projects/index.js";
import { settings } from "../settings/index.js";
import { SessionOrchestrationService, sessions } from "../sessions/index.js";
import { FileAccessService } from "../files/index.js";
function buildSessionOrchestration(projectService) {
    return new SessionOrchestrationService(sessions, () => {
        const current = settings.get();
        return {
            defaultAgent: current.defaultAgent,
            projects: projectService.list().map(({ projectId, key, label, dir }) => ({ projectId, key, label, dir })),
            providers: modelCatalog(current.defaultAgent, current.ai.defaultModel, current.ai.defaultReasoningEffort).map(({ agent, label, models, reasoningEfforts, available }) => ({ agent, label, models, reasoningEfforts, available })),
        };
    });
}
function createSessionProjectContract() {
    return {
        list: () => sessions.list(),
        renameProjectKey: (oldKey, newKey) => sessions.renameProjectKey(oldKey, newKey),
        start: (sessionOptions) => sessions.start(sessionOptions),
        rename: (id, title) => sessions.rename(id, title),
    };
}
export function createDaemonCompositionRoot(options = {}) {
    const armoryStores = options.armoryRuntime ? options.armoryRuntime.stores : createArmoryStores();
    const armoryRuntime = options.armoryRuntime ?? new ArmoryMcpRuntime(armoryStores);
    const projectService = createProjectService(projectStore, createSessionProjectContract());
    const sessionOrchestration = buildSessionOrchestration(projectService);
    const projectPackages = new ArmoryProjectPackagesService({ stores: armoryStores, projects: projectService });
    const armoryApi = {
        settings: armoryStores.settings,
        operations: armoryStores.operations,
        installer: new ArmoryPackageInstallService({ stores: armoryStores, inventory: options.armoryInventory ?? armoryInventory, runtime: armoryRuntime }),
        lifecycle: new ArmoryMcpLifecycleService(armoryRuntime),
        uninstaller: new ArmoryUninstallService({ stores: armoryRuntime.stores, runtime: armoryRuntime }),
        runtime: armoryRuntime,
        mcp: armoryRuntime,
        configuration: new ArmoryConfigurationService({ stores: armoryRuntime.stores, runtime: armoryRuntime }),
        projectPackages,
        projectPackagesCapability: true,
    };
    const cliUpdateService = options.cliUpdates ?? cliUpdates;
    const fileAccessService = new FileAccessService();
    return {
        projectService,
        sessionOrchestration,
        armoryStores,
        armoryRuntime,
        armoryApi,
        fileAccessService,
        controlServerOptions: {
            armoryInventory: options.armoryInventory,
            armoryApi,
            armoryRuntime,
            cliUpdates: cliUpdateService,
            projectService,
            sessionOrchestration,
            sessionService: sessions,
            fileAccessService,
        },
        agentRouterOptions: {
            armoryInventory: options.armoryInventory,
            armoryApi,
            projectService,
            fileAccessService,
        },
    };
}
