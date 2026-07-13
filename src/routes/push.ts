import express from "express";
import { getPushPreferences, listPushSubscriptions, removePushSubscription, setPushPreferences, upsertPushSubscription, type PushPlatform, type PushProvider } from "../push.js";
import { withWorkspace } from "./helpers.js";

const providers = new Set<PushProvider>(["expo", "fcm", "apns"]);
const platforms = new Set<PushPlatform>(["ios", "android"]);

export function pushRouter(): express.Router {
  const router = express.Router();
  router.get("/push/subscriptions", async (req, res) => res.json({ subscriptions: await listPushSubscriptions(req.user!.userId) }));
  router.put("/push/subscriptions", async (req, res) => {
    const provider = req.body?.provider as PushProvider;
    const platform = req.body?.platform as PushPlatform;
    const token = typeof req.body?.token === "string" ? req.body.token.trim() : "";
    const appId = typeof req.body?.appId === "string" ? req.body.appId.trim().slice(0, 200) : null;
    if (!providers.has(provider) || !platforms.has(platform) || token.length < 16 || token.length > 4096) {
      return res.status(400).json({ error: "valid provider, platform, and token are required", code: "BAD_PUSH_SUBSCRIPTION" });
    }
    const subscription = await upsertPushSubscription({ userId: req.user!.userId, deviceId: req.user!.deviceId, provider, platform, token, appId });
    res.status(201).json({ subscription });
  });
  router.delete("/push/subscriptions/:id", async (req, res) => {
    if (!await removePushSubscription(req.user!.userId, String(req.params.id))) return res.status(404).json({ error: "unknown subscription", code: "UNKNOWN_SUBSCRIPTION" });
    res.json({ ok: true });
  });
  router.get("/workspaces/:wsId/push/preferences", withWorkspace(async (_req, res, ctx) => {
    const p = await getPushPreferences(ctx.userId, ctx.workspaceId);
    res.json({ enabled: p.enabled, sessionEvents: p.session_events, peonEvents: p.peon_events });
  }));
  router.put("/workspaces/:wsId/push/preferences", withWorkspace(async (req, res, ctx) => {
    const value = {
      enabled: typeof req.body?.enabled === "boolean" ? req.body.enabled : true,
      sessionEvents: typeof req.body?.sessionEvents === "boolean" ? req.body.sessionEvents : true,
      peonEvents: typeof req.body?.peonEvents === "boolean" ? req.body.peonEvents : true,
    };
    res.json(await setPushPreferences(ctx.userId, ctx.workspaceId, value));
  }));
  return router;
}
