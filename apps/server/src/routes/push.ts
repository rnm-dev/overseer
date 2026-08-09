import express from "express";
import { getPushPreferences, listPushSubscriptions, removePushSubscription, setPushPreferences, upsertPushSubscription, type PushPlatform, type PushProvider } from "../modules/notifications/index.js";
import {
  bindLiveActivityUpdateToken,
  liveActivityStatus,
  registerLiveActivityStartToken,
  removeLiveActivityToken,
} from "../modules/notifications/index.js";
import { withWorkspace } from "./requestContext.js";

const providers = new Set<PushProvider>(["expo", "fcm", "apns"]);
const platforms = new Set<PushPlatform>(["ios", "android"]);

// ActivityKit hands out hex tokens; the bounds are sanity limits, not a format
// claim, because Apple has changed their length before and rejecting a valid
// token here would silently cost the operator their Live Activity.
function scalar(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function activityToken(value: unknown): string {
  const token = scalar(value, 2048);
  return /^\S{16,2048}$/.test(token) ? token : "";
}

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

  // Live Activities. The scope of an aggregate is (authenticated user,
  // authenticated device, client-supplied connection hash) — the user and device
  // come from the bearer token, never from the body, so one operator can never
  // register a token against another's aggregate.
  //
  // Responses deliberately echo no token back: a token is write-only to the
  // server, exactly like a push subscription's.
  router.get("/push/live-activities", async (req, res) => {
    res.json(await liveActivityStatus(req.user!.userId, req.user!.deviceId));
  });

  // iOS 17.2+ push-to-start. This is the capability gate for remote start: with
  // no token registered, the aggregate is reconciled by the app at launch.
  router.put("/push/live-activities/start-token", async (req, res) => {
    const connectionId = scalar(req.body?.connectionId, 200);
    const token = activityToken(req.body?.token);
    if (!connectionId || !token) {
      return res.status(400).json({ error: "connectionId and a push-to-start token are required", code: "BAD_LIVE_ACTIVITY_TOKEN" });
    }
    await registerLiveActivityStartToken({
      userId: req.user!.userId,
      deviceId: req.user!.deviceId,
      connectionId,
      token,
      bundleId: scalar(req.body?.appId ?? req.body?.bundleId, 200) || null,
    });
    res.status(201).json({ connectionId, kind: "start" });
  });

  router.delete("/push/live-activities/start-token", async (req, res) => {
    const connectionId = scalar(req.query?.connectionId ?? req.body?.connectionId, 200);
    if (!connectionId) return res.status(400).json({ error: "connectionId is required", code: "BAD_LIVE_ACTIVITY_TOKEN" });
    await removeLiveActivityToken({ userId: req.user!.userId, deviceId: req.user!.deviceId, connectionId }, "start");
    res.json({ ok: true });
  });

  // The update token ActivityKit emits once the aggregate exists — including
  // after a remote start woke the app. It binds to the existing claim; it never
  // creates a second activity.
  router.put("/push/live-activities", async (req, res) => {
    const connectionId = scalar(req.body?.connectionId, 200);
    const activityId = scalar(req.body?.activityId, 200);
    const token = activityToken(req.body?.token);
    if (!connectionId || !activityId || !token) {
      return res.status(400).json({ error: "connectionId, activityId and an update token are required", code: "BAD_LIVE_ACTIVITY_TOKEN" });
    }
    await bindLiveActivityUpdateToken({
      userId: req.user!.userId,
      deviceId: req.user!.deviceId,
      connectionId,
      activityId,
      token,
      bundleId: scalar(req.body?.appId ?? req.body?.bundleId, 200) || null,
    });
    res.status(201).json({ connectionId, activityId, kind: "update" });
  });

  // The client reporting that its activity is gone — dismissed by the user, or
  // ended locally. Releases the claim so the next run starts a fresh one.
  router.delete("/push/live-activities", async (req, res) => {
    const connectionId = scalar(req.query?.connectionId ?? req.body?.connectionId, 200);
    if (!connectionId) return res.status(400).json({ error: "connectionId is required", code: "BAD_LIVE_ACTIVITY_TOKEN" });
    await removeLiveActivityToken({ userId: req.user!.userId, deviceId: req.user!.deviceId, connectionId }, "update");
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
