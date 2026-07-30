import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Both sides of reverse-command-v1 declare the operation set as a literal
// `as const` array: Overseer to derive its request types and payload allowlist,
// Peon to type its handler tables, whose keys are what it advertises during
// capability negotiation. The two must name exactly the same operations, or an
// operation silently loses its reverse route and falls back to legacy HTTP.
//
// The declarations are read as source rather than imported: the two workspaces
// deliberately have no dependency on one another, and adding one would invert
// the daemon/server direction. packages/protocol (OVSR-239) replaces both
// copies with a single shared artifact and retires this check.
export const OPERATION_REGISTRY_SOURCES = {
  overseer: {
    file: "apps/server/src/modules/reverseCommands/reverseCommandTypes.ts",
    binding: "REVERSE_COMMAND_OPERATIONS",
  },
  peon: {
    file: "apps/peon/src/daemon/overseer/socket/channels/reverseCommandOperations.ts",
    binding: "REVERSE_COMMAND_OPERATIONS",
  },
};

export class OperationRegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "OperationRegistryError";
  }
}

export function readDeclaredOperations({ file, binding }) {
  const resolved = path.resolve(REPO_ROOT, file);
  if (!resolved.startsWith(`${REPO_ROOT}${path.sep}`)) {
    throw new OperationRegistryError(`source path escapes the repository: ${file}`);
  }
  const declaration = new RegExp(`export const ${binding} = \\[([\\s\\S]*?)\\] as const`)
    .exec(readFileSync(resolved, "utf8"));
  if (!declaration) {
    throw new OperationRegistryError(`${binding} is not declared as an "as const" array in ${file}`);
  }
  const operations = [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (operations.length === 0) {
    throw new OperationRegistryError(`${binding} in ${file} declares no operations`);
  }
  const duplicates = operations.filter((value, index) => operations.indexOf(value) !== index);
  if (duplicates.length > 0) {
    throw new OperationRegistryError(`${binding} in ${file} repeats ${duplicates.join(", ")}`);
  }
  return operations;
}

export function compareOperationRegistries(sources = OPERATION_REGISTRY_SOURCES) {
  const overseer = readDeclaredOperations(sources.overseer);
  const peon = readDeclaredOperations(sources.peon);
  const overseerSet = new Set(overseer);
  const peonSet = new Set(peon);
  return {
    overseer,
    peon,
    // An operation Overseer can send that Peon never advertises loses its
    // reverse route without any error surfacing.
    missingFromPeon: overseer.filter((operation) => !peonSet.has(operation)),
    // The reverse direction is a handler no server reaches: dead weight rather
    // than a fault, but it should be a decision.
    missingFromOverseer: peon.filter((operation) => !overseerSet.has(operation)),
  };
}
