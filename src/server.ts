import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { config } from "./config.js";
import { operatorAuth } from "./routes/helpers.js";
import { agentRouter } from "./routes/agent.js";
import { accountRouter, publicAuthRouter } from "./routes/auth.js";
import { workspacesRouter } from "./routes/workspaces.js";
import { peonsRouter } from "./routes/peons.js";
import { pushRouter } from "./routes/push.js";
import { webPreviewHandler } from "./webPreview.js";
import { peonReleasesRouter, releasePublisherRouter } from "./routes/releases.js";
import { projectViewerRouter } from "./routes/projectViewer.js";
import { voiceRouter } from "./routes/voice.js";

// The overseer's two-sided HTTP surface:
//
//   /api/v1/peons/*     NORTH-BOUND — called by peons (peonRegistrar.ts). Auth:
//                       the peon's per-peon recruitment credential.
//   /api/*              SOUTH-FACING for operators — the dashboard/mobile control
//                       surface. Auth: a device token. Peon routes are scoped to a
//                       workspace and proxy through to that peon.
//
// The route handlers live in ./routes/*; this file is just wiring.

export function isAllowedProductionHost(rawHost: string | undefined, publicUrl = config.publicUrl): boolean {
  const publicHost = new URL(publicUrl).hostname.toLowerCase().replace(/\.$/, "");
  const requestHost = (rawHost ?? "").split(":", 1)[0].toLowerCase().replace(/\.$/, "");
  return requestHost === publicHost;
}

export function createServer(): express.Express {
  const app = express();
  // Public, cookie-free preview origin. Host dispatch must happen before the
  // JSON parser and all operator routes so preview assets never touch the SPA.
  app.use(webPreviewHandler);
  // Composer prompts can include large pasted logs or source files. Express's
  // 100 KB default rejected those before they reached the session routes, even
  // though the textarea itself has no character limit. Keep a finite ceiling,
  // but allow roughly ten times the default payload size.
  app.use(express.json({ limit: "1mb" }));

  // API liveness (the SPA is served from "/" in prod; in dev nginx routes "/"
  // to the Vite server, so this stays reachable at /healthz either way).
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true });
  });

  // Production uses Overseer as the hostless fallback in the shared
  // kamal-proxy so dynamic preview subdomains can reach the same container.
  // nginx constrains public ingress, and this second boundary prevents direct
  // access to kamal-proxy:8080 with an unrelated Host from exposing the SPA/API.
  if (process.env.NODE_ENV === "production") {
    app.use((req, res, next) => {
      if (isAllowedProductionHost(req.headers.host)) return next();
      res.status(421).json({ error: "request host is not served here", code: "MISDIRECTED_REQUEST" });
    });
  }

  // North-bound: peon registration + heartbeat + event push.
  app.use("/api/v1/peons", agentRouter());
  app.use("/api/v1/releases", peonReleasesRouter());

  // Browser-facing project files use the same operator session cookie as the
  // dashboard, while native clients may still present a bearer. Workspace and
  // ACL scope are derived server-side from the stable Peon+project identity.
  app.use("/view", operatorAuth, projectViewerRouter());

  // South-facing: operator + mobile API.
  const api = express.Router();

  // The mobile app calls /api/* cross-origin. Auth is a bearer token (never a
  // cookie), so a wildcard origin is safe — there are no ambient credentials to
  // leak. The web dashboard is served same-origin and ignores this.
  api.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Actor,X-Api-Key,Peon-Content-Sha256,Peon-Request-Id,Range");
    res.setHeader("Access-Control-Expose-Headers", "Peon-Content-Sha256,Content-Range,Accept-Ranges");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // Public auth endpoints (GitHub OAuth) sit BEFORE the operator guard — they're
  // how a client gets a token.
  api.use(publicAuthRouter());

  // CI/infrastructure publishing uses its own deployment secret, not a user or
  // workspace role. This route must sit before the operator device-token guard.
  api.use(releasePublisherRouter());

  // The operator auth guard — everything below requires a device token.
  api.use(operatorAuth);
  api.use(accountRouter());
  api.use(pushRouter());
  api.use(workspacesRouter());
  api.use(peonsRouter());
  // Dictation carries a raw audio body, so it mounts its own parser with its
  // own, larger limit — under this router only.
  api.use("/v1/voice", voiceRouter());

  app.use("/api", api);

  // Production single-container build: serve the compiled React dashboard and
  // fall back to index.html for client-side routes. Inert in dev — there's no
  // web/dist (Vite serves the frontend), and nginx routes "/" to Vite anyway.
  const webDist = path.resolve("web/dist");
  if (existsSync(webDist)) {
    app.use(express.static(webDist));
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) return next();
      res.sendFile(path.join(webDist, "index.html"));
    });
  }

  return app;
}
