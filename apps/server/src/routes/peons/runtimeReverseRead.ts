import type express from "express";
import { reverseCommandGateway, type JsonObject, type ReverseCommandOperation } from "../../modules/reverseCommands/index.js";
import { runReverseCommandTransport } from "../../modules/reverseCommandTransport.js";

export async function runRuntimeCommandTransport(
  req: express.Request,
  res: express.Response,
  input: { workspaceId: string; peonId: string; operation: ReverseCommandOperation; payload?: JsonObject },
  legacy: () => Promise<void>,
): Promise<void> {
  await runReverseCommandTransport<void>({
    peonId: input.peonId,
    operation: input.operation,
    reverse: () => runtimeReverseRead(req, res, input),
    legacy,
    unavailable: async (reason) => {
      res.status(503).json({
        error: "Peon transport is unavailable",
        code: "REVERSE_TRANSPORT_UNAVAILABLE",
        reason,
      });
    },
  });
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
