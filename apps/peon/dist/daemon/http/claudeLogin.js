import express from "express";
import { ClaudeLoginError } from "../agents/index.js";
export function createClaudeLoginRouter(service, actor) {
    const router = express.Router();
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        if (!actor(req))
            return res.status(403).json({ code: "LOGIN_OWNER_REQUIRED", error: "An authenticated operator is required" });
        if (!service())
            return res.status(404).json({ code: "LOGIN_UNSUPPORTED", error: "Claude login is unavailable" });
        next();
    });
    router.post("/logout", async (req, res, next) => {
        if (req.body && Object.keys(req.body).length)
            return res.status(400).json({ code: "BAD_REQUEST", error: "Logout takes an empty body" });
        try {
            await service().logout();
            res.json({ loggedOut: true });
        }
        catch (error) {
            next(error);
        }
    });
    router.get("/login", (req, res) => res.json({ attempt: service().current(actor(req)) }));
    router.post("/login", (req, res) => {
        if (req.body && Object.keys(req.body).length)
            return res.status(400).json({ code: "BAD_REQUEST", error: "Claude login takes an empty body" });
        res.status(202).json(service().start(actor(req)));
    });
    router.get("/login/:id", (req, res) => res.json(service().get(actor(req), String(req.params.id))));
    router.post("/login/:id/code", (req, res) => {
        if (!req.body || Object.keys(req.body).some((key) => key !== "code"))
            return res.status(400).json({ code: "BAD_REQUEST", error: "Only code is accepted" });
        res.json(service().submitCode(actor(req), String(req.params.id), req.body.code));
    });
    router.delete("/login/:id", (req, res) => res.json(service().cancel(actor(req), String(req.params.id))));
    router.use((error, _req, res, _next) => {
        if (error instanceof ClaudeLoginError)
            return res.status(error.status).json({ code: error.code, error: error.message });
        res.status(500).json({ code: "LOGIN_FAILED", error: "Claude login failed" });
    });
    return router;
}
