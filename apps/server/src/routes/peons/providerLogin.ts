import type express from "express";
import { callPeon, connOfRecord } from "../../infrastructure/peonHttp/index.js";
import { ownerOnly, relay, withWorkspacePeon } from "../requestContext.js";

export function registerProviderLoginRoutes(router: express.Router) {
  const base = "/workspaces/:wsId/peons/:id/driver";
  const routes = [
    ["get", "claude-code/login"], ["post", "claude-code/login"],
    ["get", "claude-code/login/:attemptId"], ["delete", "claude-code/login/:attemptId"],
    ["post", "claude-code/login/:attemptId/code"],
    ["get", "codex/login"], ["post", "codex/login"],
    ["get", "codex/login/:attemptId"], ["delete", "codex/login/:attemptId"],
  ] as const;
  for (const [method, route] of routes) {
    router[method](`${base}/${route}`, withWorkspacePeon(async (req, res, c) => {
      res.set("Cache-Control", "no-store");
      if (!ownerOnly(res, c.role)) return;
      const target = route.replace(":attemptId", encodeURIComponent(String(req.params.attemptId ?? "")));
      relay(await callPeon(connOfRecord(c.record), method.toUpperCase(), `/driver/${target}`, {
        actor: c.operator.email,
        ...(method === "post" ? { body: req.body ?? {} } : {}),
      }), res);
    }));
  }
}
