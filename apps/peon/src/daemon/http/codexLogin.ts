import express from "express";
import { CodexLoginError, type CodexLoginService } from "../agents/index.js";

export function createCodexLoginRouter(service: () => CodexLoginService | undefined, actor: (req: express.Request) => string | null) {
  const router = express.Router();
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!actor(req)) return res.status(403).json({ code: "LOGIN_OWNER_REQUIRED", error: "An authenticated operator is required" });
    if (!service()) return res.status(404).json({ code: "LOGIN_UNSUPPORTED", error: "Codex login is unavailable" });
    next();
  });
  router.post("/logout", async (req, res, next) => {
    if (req.body && Object.keys(req.body).length) return res.status(400).json({ code: "BAD_REQUEST", error: "Logout takes an empty body" });
    try { await service()!.logout(); res.json({ loggedOut: true }); }
    catch (error) { next(error); }
  });
  router.get("/login", (req, res) => res.json({ attempt: service()!.current(actor(req)!) }));
  router.post("/login", (req, res) => {
    if (req.body && Object.keys(req.body).length) return res.status(400).json({ code: "BAD_REQUEST", error: "Codex device login takes an empty body" });
    res.status(202).json(service()!.start(actor(req)!));
  });
  router.get("/login/:id", (req, res) => res.json(service()!.get(actor(req)!, String(req.params.id))));
  router.delete("/login/:id", (req, res) => res.json(service()!.cancel(actor(req)!, String(req.params.id))));
  router.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof CodexLoginError) return res.status(error.status).json({ code: error.code, error: error.message });
    res.status(500).json({ code: "LOGIN_FAILED", error: "Codex login failed" });
  });
  return router;
}
