import express from "express";
import { registerFleetRoutes } from "./peons/fleet.js";
import { registerSessionRoutes } from "./peons/sessions.js";
import { registerProjectRoutes } from "./peons/projects.js";
import { registerArmoryRoutes } from "./peons/armory.js";

// Operator-facing Peon API. Registrars are mounted in specificity order so
// literal session/project paths retain precedence over parameterized routes.
export function peonsRouter(): express.Router {
  const router = express.Router();
  registerFleetRoutes(router);
  registerArmoryRoutes(router);
  registerSessionRoutes(router);
  registerProjectRoutes(router);
  return router;
}
