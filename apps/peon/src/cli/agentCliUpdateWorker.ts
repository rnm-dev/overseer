#!/usr/bin/env node
import { runCliUpdateWorker, type CliUpdateProvider } from "../daemon/updates/cliUpdates.js";
import { getAgentDriver } from "../daemon/agents/index.js";

function value(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

const provider = value("--provider") as CliUpdateProvider;
if (!getAgentDriver(provider)?.services.cliUpdate) throw new Error("unknown provider");
await runCliUpdateWorker({
  provider,
  command: value("--command"),
  statePath: value("--state"),
  operationId: value("--operation"),
});
