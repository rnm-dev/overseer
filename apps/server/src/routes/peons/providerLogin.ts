import type express from "express";
import { callPeon, connOfRecord } from "../../infrastructure/peonHttp/index.js";
import { ownerOnly, relay, withWorkspacePeon } from "../requestContext.js";

// Every agent driver on a Peon owns its login routes under /driver/<provider>.
// The server relays a fixed set of route shapes for any well-formed provider
// name; the Peon answers 404 for a provider it does not have.
export const PROVIDER_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

export function registerProviderLoginRoutes(router: express.Router) {
  const base = "/workspaces/:wsId/peons/:id/driver/:provider";
  const routes = [
    ["post", "logout"],
    ["get", "login"], ["post", "login"],
    ["get", "login/:attemptId"], ["delete", "login/:attemptId"],
    ["post", "login/:attemptId/code"],
  ] as const;
  for (const [method, route] of routes) {
    router[method](`${base}/${route}`, withWorkspacePeon(async (req, res, c) => {
      res.set("Cache-Control", "no-store");
      const provider = String(req.params.provider);
      if (!PROVIDER_SLUG.test(provider)) return res.status(404).json({ error: "unknown provider", code: "UNKNOWN_PROVIDER" });
      if (!ownerOnly(res, c.role)) return;
      const target = route.replace(":attemptId", encodeURIComponent(String(req.params.attemptId ?? "")));
      relay(await callPeon(connOfRecord(c.record), method.toUpperCase(), `/driver/${provider}/${target}`, {
        actor: c.operator.email,
        ...(method === "post" ? { body: req.body ?? {} } : {}),
      }), res);
    }));
  }
}
