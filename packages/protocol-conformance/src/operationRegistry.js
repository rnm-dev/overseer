import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// reverse-command-v1 has one generated operation union. The consumer audit is
// intentionally source-level: it proves both applications import that artifact
// rather than quietly reintroducing a local declaration.
export const OPERATION_REGISTRY_SOURCES = {
  canonical: {
    file: "packages/protocol/src/generated/reverseCommandV1.ts",
    binding: "REVERSE_COMMAND_OPERATIONS",
  },
  overseer: {
    file: "apps/server/src/modules/reverseCommands/reverseCommandTypes.ts",
  },
  peon: {
    file: "apps/peon/src/daemon/overseer/socket/channels/reverseCommandOperations.ts",
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
  const duplicates = operations.filter((value, index) => operations.indexOf(value) !== index);
  if (duplicates.length > 0) {
    throw new OperationRegistryError(`${binding} in ${file} repeats ${duplicates.join(", ")}`);
  }
  return operations;
}

export function compareOperationRegistries(sources = OPERATION_REGISTRY_SOURCES) {
  const operations = readDeclaredOperations(sources.canonical);
  for (const [name, consumer] of Object.entries({ overseer: sources.overseer, peon: sources.peon })) {
    const resolved = path.resolve(REPO_ROOT, consumer.file);
    const source = readFileSync(resolved, "utf8");
    if (!source.includes('from "@rnm-dev/protocol"') || !source.includes("REVERSE_COMMAND_OPERATIONS")) {
      throw new OperationRegistryError(`${name} does not consume the canonical operation registry`);
    }
  }
  return {
    overseer: operations,
    peon: operations,
    missingFromPeon: [],
    missingFromOverseer: [],
  };
}
