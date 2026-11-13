import express from "express";
export class OpencodeLoginError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = "OpencodeLoginError";
    }
}
const MAX_KEY_LENGTH = 512;
export function createOpencodeLoginRouter(service, actor) {
    const router = express.Router();
    router.use((req, res, next) => {
        res.set("Cache-Control", "no-store");
        if (!actor(req))
            return res.status(403).json({ code: "LOGIN_OWNER_REQUIRED", error: "An authenticated operator is required" });
        if (!service())
            return res.status(404).json({ code: "LOGIN_UNSUPPORTED", error: "OpenRouter login is unavailable" });
        next();
    });
    router.get("/login", (_req, res) => res.json(service().status()));
    router.post("/login", async (req, res, next) => {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        if (Object.keys(body).some((key) => key !== "apiKey") || typeof body.apiKey !== "string") {
            return res.status(400).json({ code: "BAD_REQUEST", error: "Send { apiKey } with an OpenRouter API key" });
        }
        const apiKey = body.apiKey.trim();
        if (!apiKey || apiKey.length > MAX_KEY_LENGTH || /\s/.test(apiKey)) {
            return res.status(400).json({ code: "BAD_REQUEST", error: "The OpenRouter API key is malformed" });
        }
        try {
            await service().setApiKey(apiKey);
            res.json(service().status());
        }
        catch (error) {
            next(error);
        }
    });
    router.post("/logout", async (req, res, next) => {
        if (req.body && Object.keys(req.body).length)
            return res.status(400).json({ code: "BAD_REQUEST", error: "Logout takes an empty body" });
        try {
            await service().clearApiKey();
            res.json({ loggedOut: true });
        }
        catch (error) {
            next(error);
        }
    });
    router.use((error, _req, res, _next) => {
        if (error instanceof OpencodeLoginError)
            return res.status(error.status).json({ code: error.code, error: error.message });
        res.status(500).json({ code: "LOGIN_FAILED", error: "OpenRouter login failed" });
    });
    return router;
}
