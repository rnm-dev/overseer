import express from "express";
import { registerFleetRoutes } from "./peons/fleet.js";
import { registerSessionRoutes } from "./peons/sessions.js";
import { registerProjectRoutes } from "./peons/projects.js";
import { registerArmoryRoutes } from "./peons/armory.js";
import { canAccessPeon } from "../access.js";
import { reverseCommandGateway } from "../modules/reverseCommands/index.js";
import { withWorkspace } from "./helpers.js";

// Operator-facing Peon API. Registrars are mounted in specificity order so
// literal session/project paths retain precedence over parameterized routes.
export function peonsRouter(): express.Router {
  const router = express.Router();
  router.get("/workspaces/:wsId/peons/:peonId/commands/:commandId", withWorkspace(async (req, res, c) => {
    const peonId = String(req.params.peonId);
    const result = await reverseCommandGateway.status(
      c.workspaceId,
      peonId,
      String(req.params.commandId),
      c.userId,
    );
    if (!result || !result.record
      || !(await canAccessPeon(c.workspaceId, c.userId, c.role, peonId))) {
      return res.status(404).json({ error: "unknown command", code: "UNKNOWN_COMMAND" });
    }
    res.status(result.status).json(result.body);
  }));
  registerFleetRoutes(router);
  registerArmoryRoutes(router);
  registerSessionRoutes(router);
  registerProjectRoutes(router);
  return router;
}
