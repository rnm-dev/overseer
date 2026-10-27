import type express from "express";
import { agentServiceName, listAgentDrivers } from "../agents/index.js";

// Each driver that supports login owns its routes under /driver/<service name>
// (`/driver/claude-code`, `/driver/codex`).
export function mountDriverLoginRoutes(router: express.IRouter, prefix: string, actor: (req: express.Request) => string | null): void {
  for (const driver of listAgentDrivers()) {
    const loginRouter = driver.services.loginRouter;
    if (loginRouter) router.use(`${prefix}/${agentServiceName(driver)}`, loginRouter(actor));
  }
}
