import { readdir } from "node:fs/promises";
import { getArmoryActivation } from "./installer.js";
import { initializeArmoryDirectories, type ArmoryStores } from "./stores.js";

export interface ArmoryInstalledStateReconciliation {
  restored: string[];
  pruned: string[];
  unresolved: Array<{ packageId: string; error: unknown }>;
}

/**
 * Rebuilds the installed-package projection from committed activation records.
 * Activation is the install authority; installed.json is only its query view.
 */
export async function reconcileArmoryInstalledState(stores: ArmoryStores): Promise<ArmoryInstalledStateReconciliation> {
  await initializeArmoryDirectories(stores.paths);
  const installed = await stores.installed.list();
  const installedById = new Map(installed.map((record) => [record.id, record]));
  const activationIds = (await readdir(stores.paths.activeDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[a-z0-9][a-z0-9-]{0,62}\.json$/.test(entry.name))
    .map((entry) => entry.name.slice(0, -".json".length));
  const packageIds = [...new Set([...installedById.keys(), ...activationIds])].sort();
  const result: ArmoryInstalledStateReconciliation = { restored: [], pruned: [], unresolved: [] };

  for (const packageId of packageIds) {
    try {
      const activation = await getArmoryActivation(stores, packageId);
      const projected = installedById.get(packageId);
      if (!activation) {
        if (projected) {
          await stores.installed.remove(packageId);
          await stores.projectPackages.update((state) => ({
            ...state,
            assignments: state.assignments.filter((assignment) => assignment.packageId !== packageId),
          }));
          result.pruned.push(packageId);
        }
        continue;
      }
      if (!projected || JSON.stringify(projected) !== JSON.stringify(activation.installed)) {
        await stores.installed.set(activation.installed);
        result.restored.push(packageId);
      }
    } catch (error) {
      // A corrupt activation remains visible as a package-local error. Do not
      // guess at deleting its artifact or let it block reconciliation of peers.
      result.unresolved.push({ packageId, error });
    }
  }
  return result;
}
