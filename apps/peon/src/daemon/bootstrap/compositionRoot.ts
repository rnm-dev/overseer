import { modelCatalog } from "../providers/modelCatalog.js";
import { cliUpdates, type CliUpdateService } from "../updates/cliUpdates.js";
import { createArmoryStores, ArmoryConfigurationService, ArmoryMcpLifecycleService, ArmoryMcpRuntime, ArmoryPackageInstallService, ArmoryProjectPackagesService, ArmoryUninstallService, armoryInventory, type ArmoryApiServices, type ArmoryInventoryReader } from "../armory/index.js";
import { createProjectService, projectStore, type ProjectService } from "../projects/index.js";
import { settings } from "../settings/index.js";
import { SessionOrchestrationService, sessions } from "../sessions/index.js";
import { FileAccessService, type FileAccessContract } from "../files/index.js";
import type {
  ProjectSessionContract,
} from "../sessions/index.js";

export interface DaemonCompositionOptions {
  armoryInventory?: ArmoryInventoryReader;
  armoryRuntime?: ArmoryMcpRuntime;
  cliUpdates?: CliUpdateService;
}

export interface DaemonComposition {
  projectService: ProjectService;
  sessionOrchestration: SessionOrchestrationService;
  armoryStores: ReturnType<typeof createArmoryStores>;
  armoryRuntime: ArmoryMcpRuntime;
  armoryApi: Omit<ArmoryApiServices, "allowMutations">;
  fileAccessService: FileAccessContract;
  controlServerOptions: {
    armoryInventory?: ArmoryInventoryReader;
    armoryApi: Omit<ArmoryApiServices, "allowMutations">;
    armoryRuntime: ArmoryMcpRuntime;
    cliUpdates: CliUpdateService;
    projectService: ProjectService;
    sessionOrchestration: SessionOrchestrationService;
    sessionService?: typeof sessions;
    fileAccessService?: FileAccessContract;
  };
  agentRouterOptions: {
    armoryInventory?: ArmoryInventoryReader;
    armoryApi: Omit<ArmoryApiServices, "allowMutations">;
    projectService: ProjectService;
    fileAccessService?: FileAccessContract;
  };
}

function buildSessionOrchestration(projectService: ProjectService): SessionOrchestrationService {
  return new SessionOrchestrationService(sessions, () => {
    const current = settings.get();
    return {
      defaultAgent: current.defaultAgent,
      projects: projectService.list().map(({ projectId, key, label, dir }) => ({ projectId, key, label, dir })),
      providers: modelCatalog(current.defaultAgent, current.ai.defaultModel, current.ai.defaultReasoningEffort).map(
        ({ agent, label, models, reasoningEfforts, available }) => ({ agent, label, models, reasoningEfforts, available }),
      ),
    };
  });
}

function createSessionProjectContract(): ProjectSessionContract {
  return {
    list: () => sessions.list(),
    renameProjectKey: (oldKey, newKey) => sessions.renameProjectKey(oldKey, newKey),
    start: (sessionOptions) => sessions.start(sessionOptions),
    rename: (id, title) => sessions.rename(id, title),
  };
}

export function createDaemonCompositionRoot(options: DaemonCompositionOptions = {}): DaemonComposition {
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
