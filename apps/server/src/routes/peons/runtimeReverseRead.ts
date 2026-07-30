import type express from "express";
import { getPeonConnection, peonConnectionSupportsCommand } from "../../peonConnections.js";
import { reverseCommandGateway, type JsonObject, type ReverseCommandOperation } from "../../modules/reverseCommands/index.js";

export function hasRuntimeReverseRead(peonId: string, operation: ReverseCommandOperation): boolean {
  const socket = getPeonConnection(peonId);
  return Boolean(socket && peonConnectionSupportsCommand(socket, operation));
}

export async function runtimeReverseRead(
  req: express.Request,
  res: express.Response,
  input: { workspaceId: string; peonId: string; operation: ReverseCommandOperation; payload?: JsonObject },
): Promise<void> {
  const response = await reverseCommandGateway.submit({
    ...input, auth: req.user!, target: {}, waitMs: 15_000,
  });
  if (response.status === 200 && response.body.status === "applied") {
    res.json(response.body.result);
    return;
  }
  const code = String(response.body.code ?? "RUNTIME_QUERY_FAILED");
  res.status(code === "BAD_COMMAND" ? 400 : code === "UNKNOWN_PROVIDER" ? 404 : response.status)
    .json({ error: code === "COMMAND_TIMEOUT" ? "runtime query timed out" : "runtime query failed", code });
}

export function analyticsQuery(query: express.Request["query"]): JsonObject | null {
  const entries = Object.entries(query);
  if (entries.length > 24) return null;
  const out: JsonObject = {};
  for (const [key, value] of entries) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item === "string")) out[key] = value as string[];
    else return null;
  }
  return out;
}
