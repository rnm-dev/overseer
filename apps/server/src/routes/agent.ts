import express from "express";
import { registry, toView, type PeonLoad } from "../registry.js";
import { reconcilePeon, ingestEvents } from "../sessionIndex.js";
import { appendEvent, broadcast } from "../eventLog.js";
import { bindPeon } from "../credentials.js";
import { bearer, credentialAuth, sourceAddress } from "./helpers.js";
import { normalizePeonUrl } from "../peonClient.js";

// NORTH-BOUND — mounted at /api/v1/peons. Called by peons (peonRegistrar.ts /
// peonEventPusher.ts). Auth: the peon's per-peon recruitment credential, which
// also tells us which workspace the peon belongs to.
export function agentRouter(): express.Router {
  const router = express.Router();
  router.use(credentialAuth);

  router.post("/register", async (req, res) => {
    const b = req.body ?? {};
    const cred = req.peonCred!;
    if (typeof b.peonId !== "string" || !b.peonId.trim()) return res.status(400).json({ error: "peonId is required", code: "BAD_REQUEST" });
    if (typeof b.controlPort !== "number") return res.status(400).json({ error: "controlPort (number) is required", code: "BAD_REQUEST" });
    const peonId = b.peonId.trim();
    if (cred.boundPeonId && cred.boundPeonId !== peonId) return res.status(409).json({ error: "credential is already bound to a different Peon", code: "PEON_ID_MISMATCH" });
    const publicUrl = b.publicUrl === undefined ? null : typeof b.publicUrl === "string" ? normalizePeonUrl(b.publicUrl) : null;
    if (b.publicUrl !== undefined && !publicUrl) return res.status(400).json({ error: "publicUrl must be an http(s) URL without credentials, query, or fragment", code: "BAD_PUBLIC_URL" });
    if (!(await bindPeon(cred.id, peonId))) return res.status(409).json({ error: "credential is already bound to a different Peon", code: "PEON_ID_MISMATCH" });
    const record = await registry.register({
      peonId,
      credentialId: cred.id,
      workspaceId: cred.workspaceId,
      name: typeof b.name === "string" ? b.name : peonId,
      hostname: typeof b.hostname === "string" ? b.hostname : null,
      address: sourceAddress(req),
      controlPort: b.controlPort,
      publicUrl,
      protocol: typeof b.protocol === "number" ? b.protocol : null,
      capabilities: Array.isArray(b.capabilities) ? b.capabilities.filter((c: unknown) => typeof c === "string") : [],
      token: bearer(req),
      load: extractLoad(b),
    });
    // Warm the index for this peon without blocking the response.
    void reconcilePeon(record).catch(() => null);
    // Durable peon event — a topology change worth replaying on resume.
    void appendEvent({ workspaceId: record.workspaceId, peonId, kind: "peon", payload: toView(record) }).catch(() => null);
    res.status(201).json(toView(record));
  });

  router.post("/:id/heartbeat", async (req, res) => {
    const record = await registry.heartbeat(String(req.params.id), req.peonCred!.id, extractLoad(req.body ?? {}));
    // 404 tells the peon we lost it, so it re-registers.
    if (!record) return res.status(404).json({ error: "unknown peon — re-register", code: "UNKNOWN_PEON" });
    // Heartbeats retain load/freshness metadata. Socket presence is the sole
    // online/offline authority, so this broadcast cannot make a Peon online.
    broadcast({ workspaceId: record.workspaceId, peonId: record.peonId, kind: "peon", payload: toView(record) });
    res.json(toView(record));
  });

  // Session event push — keeps the index live (peonEventPusher.ts).
  router.post("/:id/events", async (req, res) => {
    const peonId = String(req.params.id);
    const body = req.body ?? {};
    if (typeof body.epoch !== "string" || !Array.isArray(body.events)) {
      return res.status(400).json({ error: "epoch (string) and events (array) are required", code: "BAD_REQUEST" });
    }
    // Must be a known peon owned by this credential; unknown ⇒ 404 so it re-registers.
    const rec = await registry.get(peonId);
    if (!rec || rec.credentialId !== req.peonCred!.id) return res.status(404).json({ error: "unknown peon — re-register", code: "UNKNOWN_PEON" });
    const events = (body.events as unknown[]).filter(
      (e): e is { seq: number; session: { id: string } } =>
        !!e && typeof (e as { seq?: unknown }).seq === "number" && !!(e as { session?: unknown }).session,
    );
    const result = await ingestEvents(rec.workspaceId, peonId, body.epoch, events);
    res.json({ ok: true, ...result });
  });

  return router;
}

function extractLoad(b: Record<string, unknown>): PeonLoad | null {
  if (typeof b.activeSessions !== "number" || typeof b.paused !== "boolean") return null;
  return { activeSessions: b.activeSessions, paused: b.paused, uptimeSec: typeof b.uptimeSec === "number" ? b.uptimeSec : 0 };
}
