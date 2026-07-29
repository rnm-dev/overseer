import { randomUUID } from "node:crypto";
import { readFileSync, statSync, watch } from "node:fs";
import { eventLoopDelayStats } from "./eventLoopMonitor.js";
import path from "node:path";
import express from "express";
import { settings } from "./settings/index.js";
import { users, normalizeUsername, DEFAULT_ADMIN_USERNAME } from "./users.js";
import { authSessions, AUTH_SESSION_COOKIE, SESSION_MAX_AGE_SEC, stripSecrets } from "./authSessions.js";
import { sessionPresence, DASHBOARD_PRESENCE_KEY } from "./sessionPresence.js";
import {
  sessionArtifactInventory,
  SessionOrchestrationService,
  type ProjectSessionContract,
  sessions,
  toPublicSessionRecord,
  type SessionRecord,
} from "./sessions/index.js";
import { createProjectService, projectStore, type ProjectService } from "./projects/index.js";
import { updateChecker } from "./updateChecker.js";
import { createAgentRouter } from "./agentApi.js";
import { createHumanProjectsRouter } from "./http/human/projects.js";
import { createHumanSessionsRouter, type HumanSessionResponseHelpers, type HumanSessionService } from "./http/human/sessions.js";
import { createScopedMcpRouter } from "./scopedMcp.js";
import { pairing } from "./pairing.js";
import { modelCatalog, narrowNewSessionAgent, narrowModel, narrowReasoningEffort } from "./modelCatalog.js";
import { agentServices, getAgentDriver, listAgentDrivers } from "./agents/index.js";
import { startSelfUpdate } from "./selfUpdate.js";
import { attachHumanFilesystemRoutes } from "./http/human/files.js";
import { peonRegistrar, peonSocket } from "./overseer/index.js";
import type { QuotaProvider } from "./providerQuota.js";
import { ArmoryMcpLifecycleService, ArmoryMcpRuntime, ArmoryUninstallService, createArmoryReadRouter, createArmoryStores, type ArmoryApiServices, type ArmoryInventoryReader } from "./armory/index.js";
import {
  type FileAccessContract,
  FileAccessService,
} from "./files/index.js";
import { toSessionSummary } from "./sessionSummary.js";
import { paginateTranscript, parseTranscriptPageRequest, parseTranscriptResumeEventId, transcriptResumeIndex, TranscriptPaginationError } from "./transcriptPagination.js";
import { analyticsForSessions, parseSessionAnalyticsQuery, SessionAnalyticsQueryError } from "./sessionAnalytics.js";
import { cliUpdates, CliUpdateError, type CliUpdateProvider, type CliUpdateService } from "./cliUpdates.js";

const startedAt = Date.now();
const SSE_HEARTBEAT_MS = Number(process.env.ACA_SSE_HEARTBEAT_MS) || 15_000;

// Joins ephemeral, in-memory viewer presence onto the persisted
// SessionRecord for API responses only — SessionRecord itself (and what
// gets written to <id>.summary.json) stays untouched. viewers seeds
// SessionDetail's initial render before its first SSE "presence" frame
// arrives; viewerCount powers the sessions-list row badge.
//
// The requesting user is excluded from `viewers` — the badge is meant to
// surface *other* people looking at a session, so someone who's the only
// viewer of their own open session shouldn't see a "1 viewing" badge for
// themselves. The SSE presence stream (GET /api/v1/sessions/:id/stream) applies
// the same per-connection exclusion.
function toSessionView(record: SessionRecord, viewerUsername: string | null) {
  const viewers = sessionPresence.list(record.id).filter((u) => u !== viewerUsername);
  return { ...toPublicSessionRecord(record), viewers, viewerCount: viewers.length };
}

function readCookies(req: express.Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  return Object.fromEntries(
    header.split(";").map((pair) => {
      const i = pair.indexOf("=");
      return [pair.slice(0, i).trim(), decodeURIComponent(pair.slice(i + 1).trim())];
    }),
  );
}

// The daemon/dashboard/CLI/scripts all talk to this API from the same box —
// only a genuinely remote peer needs to authenticate. Uses the raw socket
// address (not `req.ip`/X-Forwarded-For, which a client can set) so this
// can't be spoofed by a request header.
function isLoopback(req: express.Request): boolean {
  const addr = req.socket.remoteAddress;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function clientInfo(req: express.Request) {
  return { ip: req.socket.remoteAddress ?? null, userAgent: req.headers["user-agent"] ?? null };
}

// The username-only half of the auth-gate middleware's own lookup — shared
// by /api/v1/auth/status and the session presence tracking below. Not used by
// the auth gate itself, which needs the full AuthSessionRecord (for
// shouldRenew/renew), not just the username.
function resolveUsername(req: express.Request): string | null {
  if (isLoopback(req)) return DEFAULT_ADMIN_USERNAME;
  const token = readCookies(req)[AUTH_SESSION_COOKIE];
  const record = token ? authSessions.verifySessionToken(token) : null;
  return record?.username ?? null;
}

function setSessionCookie(req: express.Request, res: express.Response, compoundToken: string): void {
  res.cookie(AUTH_SESSION_COOKIE, compoundToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: SESSION_MAX_AGE_SEC * 1000,
    path: "/",
  });
}

export interface ControlServerOptions {
  armoryInventory?: ArmoryInventoryReader;
  armoryApi?: Omit<ArmoryApiServices, "allowMutations">;
  armoryRuntime?: ArmoryMcpRuntime;
  cliUpdates?: CliUpdateService;
  projectService?: ProjectService;
  fileAccessService?: FileAccessContract;
  sessionOrchestration?: SessionOrchestrationService;
  sessionService?: HumanSessionService;
  sessionHelpers?: HumanSessionResponseHelpers;
}

export function createControlServer(options: ControlServerOptions = {}) {
  const app = express();
  const cliUpdateService = options.cliUpdates ?? cliUpdates;
  const fileAccessService = options.fileAccessService ?? new FileAccessService();
  const armoryRuntime = options.armoryRuntime ?? new ArmoryMcpRuntime(createArmoryStores());
  const armoryApi = options.armoryApi ?? {
    lifecycle: new ArmoryMcpLifecycleService(armoryRuntime),
    uninstaller: new ArmoryUninstallService({ stores: armoryRuntime.stores, runtime: armoryRuntime }),
    runtime: armoryRuntime,
    mcp: armoryRuntime,
  };
  const sessionProjectContract: ProjectSessionContract = {
    list: () => sessions.list(),
    renameProjectKey: (oldKey, newKey) => sessions.renameProjectKey(oldKey, newKey),
    start: (sessionOptions) => sessions.start(sessionOptions),
    rename: (id, title) => sessions.rename(id, title),
  };
  const projectService = options.projectService ?? createProjectService(projectStore, sessionProjectContract);
  const sessionOrchestration = options.sessionOrchestration ?? new SessionOrchestrationService(sessions, () => {
    const current = settings.get();
    return {
      defaultAgent: current.defaultAgent,
      projects: projectService.list().map(({ projectId, key, label, dir }) => ({ projectId, key, label, dir })),
      providers: modelCatalog(current.defaultAgent, current.ai.defaultModel, current.ai.defaultReasoningEffort).map(
        ({ agent, label, models, reasoningEfforts, available }) => ({
          agent, label, models, reasoningEfforts, available,
        }),
      ),
    };
  });
  const sessionService = options.sessionService ?? sessions;
  const sessionHelpers: HumanSessionResponseHelpers = options.sessionHelpers ?? {
    toSessionSummary,
    toPublicSessionRecord,
    toSessionView,
    resolveSessionAuthor: (req) => resolveUsername(req) ?? undefined,
    resolveSessionViewer: (req) => resolveUsername(req),
    resolveDefaultAgent: () => settings.get().defaultAgent,
    listAgentsForNewSessionError: () => listAgentDrivers({ visible: true, available: true }).map((driver) => driver.id).join(", "),
    narrowNewSessionAgent: narrowNewSessionAgent,
    narrowModel: narrowModel,
    narrowReasoningEffort: narrowReasoningEffort,
  };
  app.use(express.json());

  const dashboardPort = process.env.ACA_DASHBOARD_PORT ?? "4571";
  const staticAllowedOrigins = new Set([`http://127.0.0.1:${dashboardPort}`, `http://localhost:${dashboardPort}`]);

  // When the dashboard is reached remotely it loads from publicDashboardUrl, so
  // credentialed cross-origin calls to this API arrive with that Origin — allow it
  // too. Read per-request (not captured once) so `peon remote on` takes effect on
  // the next request without a control-API restart. Loopback origins stay allowed
  // regardless, for the same-box browser/CLI.
  function isAllowedOrigin(origin: string): boolean {
    // Sandboxed HTML previews intentionally have an opaque origin, serialized
    // by browsers as `null`. Their fetch/XHR calls should behave like the page
    // would when served normally; the iframe/CSP sandbox still isolates DOM,
    // storage, navigation, and parent access.
    if (origin === "null") return true;
    if (staticAllowedOrigins.has(origin)) return true;
    return origin === settings.get().publicDashboardUrl.replace(/\/$/, "");
  }

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isAllowedOrigin(origin)) {
      res.header("Access-Control-Allow-Origin", origin);
      res.header("Access-Control-Allow-Credentials", "true");
    }
    res.header("Access-Control-Allow-Methods", "GET,PATCH,POST,DELETE");
    res.header(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, Peon-Actor, Peon-Protocol, Peon-Request-Id",
    );
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  // One public API namespace, with the caller's credential selecting its
  // capability profile. Bearer/protocol requests use the fleet representation;
  // browser-cookie and genuine-loopback requests continue into the human/admin
  // handlers below. Enrollment is the only fleet route that precedes bearer
  // authentication, so route it explicitly as part of that profile.
  const fleetRouter = createAgentRouter({
    armoryInventory: options.armoryInventory,
    armoryApi,
    projectService,
  });
  app.use("/api/v1", (req, res, next) => {
    // Profile selection must only decide which auth middleware receives the
    // request. Do not validate the Bearer shape here: doing so lets a request
    // with an Authorization header fall through to the unrelated dashboard
    // cookie gate, which responds with the misleading "not authenticated".
    // createAgentRouter performs the actual strict Bearer validation.
    const fleetRequest =
      req.path === "/enroll" ||
      req.headers.authorization !== undefined ||
      req.headers["peon-protocol"] !== undefined ||
      req.headers["peon-request-id"] !== undefined ||
      req.headers["peon-actor"] !== undefined;
    if (fleetRequest) {
      // Never let an authenticated Fleet-profile request fall through into
      // dashboard cookie auth when its route is unknown (notably when an
      // Overseer is newer than the Peon it controls). That used to turn a
      // useful 404 into the misleading plain-text-profile 401
      // "not authenticated".
      return fleetRouter(req, res, () => {
        if (!res.headersSent) res.status(404).json({ error: "not found", code: "NOT_FOUND" });
      });
    }
    next();
  });

  // Local coding agents use enabled Armory MCP packages. Mounted before the
  // dashboard cookie gate because the MCP router has a stricter boundary of
  // its own: genuine loopback, no browser Origin, and a loopback Host header.
  app.use("/mcp", createScopedMcpRouter({ armoryRuntime, projectService, sessionOrchestration }));

  // The magic link itself points at the dashboard (a `?token=` on its own origin, not
  // this API) — the dashboard page reads the token client-side and POSTs it here itself,
  // a plain cross-origin fetch like every other dashboard->API call (see isAllowedOrigin
  // above). That's also why this is a POST despite never being submitted via a form: it's
  // no longer a browser-navigated link, and consuming a token is a mutating action.
  app.post("/api/v1/auth/consume", (req, res) => {
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    const result = token ? authSessions.consumeLink(token, clientInfo(req)) : null;
    if (!result) {
      return res.status(401).json({ ok: false, error: "This link is invalid, expired, or has already been used." });
    }
    setSessionCookie(req, res, `${result.record.id}.${result.rawSessionToken}`);
    res.json({ ok: true });
  });

  app.post("/api/v1/auth/logout", (req, res) => {
    const token = readCookies(req)[AUTH_SESSION_COOKIE];
    const record = token ? authSessions.verifySessionToken(token) : null;
    if (record) authSessions.revoke(record.id);
    res.clearCookie(AUTH_SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });

  app.get("/api/v1/auth/status", (req, res) => {
    const username = resolveUsername(req);
    res.json({ authenticated: username !== null, username });
  });

  app.use((req, res, next) => {
    if (isLoopback(req)) return next();
    const token = readCookies(req)[AUTH_SESSION_COOKIE];
    const record = token ? authSessions.verifySessionToken(token) : null;
    if (!record) return res.status(401).json({ error: "not authenticated" });
    if (authSessions.shouldRenew(record)) {
      authSessions.renew(record, clientInfo(req));
      setSessionCookie(req, res, token);
    }
    next();
  });

  app.use("/api/v1/armory", createArmoryReadRouter(options.armoryInventory, {
    ...armoryApi,
    allowMutations: true,
  }));

  app.post("/api/v1/users/:username", (req, res) => {
    const username = normalizeUsername(req.params.username);
    if (!username) return res.status(400).json({ error: "invalid username" });
    const { record, created } = users.create(username);
    res.status(created ? 201 : 200).json({ ok: true, username: record.username, created });
  });

  app.post("/api/v1/users/:username/auth-link", (req, res) => {
    const username = normalizeUsername(req.params.username);
    if (!username) return res.status(400).json({ error: "invalid username" });
    if (!users.get(username)) return res.status(404).json({ error: "unknown user — create it first with `peon user add`" });
    const { record, rawLinkToken } = authSessions.issueLink(username);
    const linkUrl = `${settings.get().publicDashboardUrl.replace(/\/$/, "")}/?token=${record.id}.${rawLinkToken}`;
    res.status(201).json({ ok: true, username, linkUrl, expiresAt: record.linkExpiresAt });
  });

  app.get("/api/v1/users", (_req, res) => {
    res.json({ users: users.list() });
  });

  app.get("/api/v1/users/:username/sessions", (req, res) => {
    const username = normalizeUsername(req.params.username);
    if (!username || !users.get(username)) return res.status(404).json({ error: "unknown user" });
    res.json({ sessions: authSessions.listByUsername(username).map(stripSecrets) });
  });

  app.delete("/api/v1/users/:username/sessions", (req, res) => {
    const username = normalizeUsername(req.params.username);
    if (!username || !users.get(username)) return res.status(404).json({ error: "unknown user" });
    res.json({ ok: true, revokedCount: authSessions.revokeAllForUser(username) });
  });

  app.delete("/api/v1/users/:username/sessions/:id", (req, res) => {
    const username = normalizeUsername(req.params.username);
    const record = authSessions.get(req.params.id);
    if (!username || !record || record.username !== username) {
      return res.status(404).json({ error: "unknown session" });
    }
    authSessions.revoke(record.id);
    res.json({ ok: true });
  });

  app.get("/api/v1/status", (_req, res) => {
    const updateState = updateChecker.getState();
    res.json({
      state: settings.get().paused ? "paused" : "idle",
      currentTask: null,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      updateAvailable: updateState.updateAvailable,
      updateCurrentVersion: updateState.currentVersion,
      updateLatestVersion: updateState.latestVersion,
      updateCurrentRevision: updateState.currentRevision,
      updateLatestRevision: updateState.latestRevision,
      updateCheckedAt: updateState.checkedAt,
      updateCheckError: updateState.error,
      // Seeds the dashboard's active-users list before its "presence" SSE
      // stream (GET /api/v1/presence/stream) delivers its own snapshot — same
      // pattern as toSessionView's `viewers` seeding a session's own list.
      activeUsers: sessionPresence.list(DASHBOARD_PRESENCE_KEY),
      // Cheap piggyback so the sidebar can render its "AI" warning dot off
      // the poll it's already subscribed to — full detail lives in
      // GET /api/v1/ai/claude-code/status.
      claudeCodeAuthState: (getAgentDriver("claude-code")?.services.status?.() as { authState?: string } | undefined)?.authState,
      // Live fleet-link state for the Overseer view + sidebar warn dot, off the
      // same poll. `enabled` reflects whether overseerUrl+overseerToken are set;
      // `derecruited` (a revoked credential) is what the sidebar flags.
      overseer: { ...peonRegistrar.getState(), socket: peonSocket.getState() },
      eventLoopDelay: eventLoopDelayStats(),
    });
  });

  app.use("/api/v1", createHumanProjectsRouter({
    projectService,
    resolveCreateActor: (req) => resolveUsername(req) ?? undefined,
  }));

  app.use("/api/v1", createHumanSessionsRouter({
    sessionService,
    helpers: sessionHelpers,
    resolveSessionId: () => randomUUID(),
  }));

  attachHumanFilesystemRoutes(app, { fileAccessService });


  app.get("/api/v1/settings", (_req, res) => {
    res.json(settings.getControlSettingsView());
  });

  app.patch("/api/v1/settings", (req, res) => {
    try {
      const { view } = settings.patchControlSettings(req.body ?? {});
      res.json(view);
    } catch (error) {
      if ((error as { code?: string; error?: string }).code === "BAD_REQUEST") {
        return res.status(400).json({ error: (error as { error: string }).error, code: "BAD_REQUEST" });
      }
      throw error;
    }
  });

  // Recruitment: (re)arm a single-use pairing phrase so an operator can connect
  // this peon to an overseer (or re-point an already-recruited one at a new
  // workspace). Backs `peon pair`; sits behind the same loopback/magic-link gate
  // as the rest of /api. The phrase is returned once, here — see pairing.ts.
  app.post("/api/v1/pairing/arm", (_req, res) => {
    const { phrase, expiresAt } = pairing.arm();
    res.json({ ok: true, phrase, expiresAt });
  });

  app.post("/api/v1/control/pause", (_req, res) => {
    res.json(settings.update({ paused: true }));
  });

  app.post("/api/v1/control/resume", (_req, res) => {
    res.json(settings.update({ paused: false }));
  });

  app.post("/api/v1/control/update", (req, res) => {
    const result = startSelfUpdate({ force: req.body?.force === true });
    if (result.busy) {
      return res.status(409).json({
        error: "a session is currently running (updating restarts the daemon, which kills it) — pass { force: true } to override",
      });
    }
    res.status(202).json({
      ok: true,
      manualRestartRequired: result.manualRestartRequired,
      message: result.manualRestartRequired
        ? `update started — the dev daemon will keep running; check ${result.logPath}, then restart \`npm run dev\` manually when safe`
        : `update started — poll GET /api/v1/status, or check ${result.logPath}`,
    });
  });

  const STATS_PERIODS = ["day", "yesterday", "week", "month"];

  app.get("/api/v1/ai/stats", (req, res) => {
    const period = typeof req.query.period === "string" ? req.query.period : "day";
    if (!STATS_PERIODS.includes(period)) {
      return res.status(400).json({ error: `invalid period (expected one of ${STATS_PERIODS.join(", ")})` });
    }
    res.json(sessions.statsForPeriod(period as "day" | "yesterday" | "week" | "month"));
  });

  app.get("/api/v1/ai/analytics", (req, res) => {
    try {
      const query = parseSessionAnalyticsQuery(req.query as Record<string, unknown>);
      res.json(analyticsForSessions(sessions.list(), query, sessionArtifactInventory()));
    } catch (error) {
      if (error instanceof SessionAnalyticsQueryError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  app.get("/api/v1/ai/claude-code/status", (_req, res) => {
    res.json(getAgentDriver("claude-code")?.services.status?.() ?? null);
  });

  app.get("/api/v1/ai/status/:provider", (req, res) => {
    const driver = getAgentDriver(req.params.provider);
    if (!driver) return res.status(404).json({ error: "unknown status provider" });
    res.json(driver.services.status?.() ?? null);
  });

  app.get("/api/v1/ai/cli-updates", async (req, res) => {
    res.json(await cliUpdateService.get(undefined, req.query.refresh === "1"));
  });

  app.get("/api/v1/ai/cli-updates/:provider", async (req, res) => {
    const provider = req.params.provider as CliUpdateProvider;
    if (!getAgentDriver(provider)?.capabilities.cliUpdate) return res.status(404).json({ error: "unknown CLI provider", code: "UNKNOWN_PROVIDER" });
    res.json((await cliUpdateService.get(provider, req.query.refresh === "1")).providers[0]);
  });

  app.post("/api/v1/ai/cli-updates/:provider", async (req, res) => {
    const provider = req.params.provider as CliUpdateProvider;
    if (!getAgentDriver(provider)?.capabilities.cliUpdate) return res.status(404).json({ error: "unknown CLI provider", code: "UNKNOWN_PROVIDER" });
    try {
      res.status(202).json({ provider, operation: await cliUpdateService.start(provider) });
    } catch (error) {
      if (error instanceof CliUpdateError) {
        const status = error.code === "UPDATE_START_FAILED" ? 500 : 409;
        return res.status(status).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  // Provider-reported account quota, separate from Peon's per-session stats.
  app.get("/api/v1/ai/quota", async (req, res) => {
    res.json(await agentServices.quotas(req.query.refresh === "1"));
  });

  app.get("/api/v1/ai/quota/:provider", async (req, res) => {
    const provider = req.params.provider as QuotaProvider;
    if (!getAgentDriver(provider)?.capabilities.quota) return res.status(404).json({ error: "unknown quota provider" });
    res.json(await agentServices.quota(provider, req.query.refresh === "1"));
  });

  app.get("/api/v1/ai/capabilities", async (req, res) => {
    res.json(await agentServices.allCapabilities(req.query.refresh === "1"));
  });

  app.get("/api/v1/ai/capabilities/:provider", async (req, res) => {
    const provider = req.params.provider as QuotaProvider;
    if (!getAgentDriver(provider)) return res.status(404).json({ error: "unknown capabilities provider" });
    res.json(await agentServices.capabilities(provider, req.query.refresh === "1"));
  });

  // The model catalog for the dashboard's model pickers — same payload as the
  // fleet-facing GET /api/v1/models, so the dashboard needn't use bearer auth
  // surface. Defaults are marked directly on their list records.
  app.get("/api/v1/models", (_req, res) => {
    const s = settings.get();
    res.json({
      defaultAgent: s.defaultAgent,
      providers: modelCatalog(s.defaultAgent, s.ai.defaultModel, s.ai.defaultReasoningEffort),
    });
  });

  app.get("/api/v1/sessions/:id/transcript", (req, res) => {
    if (!sessions.get(req.params.id)) return res.status(404).json({ error: "unknown session" });
    try {
      const pagination = parseTranscriptPageRequest(req.query.limit, req.query.cursor);
      if (!pagination) return res.json({ events: sessions.getTranscript(req.params.id) });
      res.json(paginateTranscript(req.params.id, sessions.getTranscriptEntries(req.params.id), pagination));
    } catch (error) {
      if (error instanceof TranscriptPaginationError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      throw error;
    }
  });

  // Session-scoped workspace access. The session cwd is the authority here,
  // rather than projectKey: ad-hoc sessions may not belong to a registered
  // project, and a project session may deliberately run in a nested cwd.
  app.get("/api/v1/sessions/:id/files", (req, res) => {
    const record = sessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: "unknown session" });
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    try {
      const absDir = fileAccessService.resolveFromDir(record.dir, subpath);
      res.json({ path: absDir, entries: fileAccessService.listDirEntries(absDir, absDir) });
    } catch (err) {
      const { status, message } = fileAccessService.dirErrorResponse(err);
      res.status(status).json({ error: message });
    }
  });

  app.get("/api/v1/sessions/:id/file", (req, res) => {
    const record = sessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: "unknown session" });
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    if (!subpath) return res.status(400).json({ error: "path is required" });
    try {
      const absPath = fileAccessService.resolveFromDir(record.dir, subpath);
      res.json({ ...fileAccessService.readFileView(absPath), path: absPath });
    } catch (err) {
      const { status, message } = fileAccessService.fileErrorResponse(err);
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/v1/sessions/:id/preview", (req, res) => {
    const record = sessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: "unknown session" });
    const requestedPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!requestedPath) return res.status(400).json({ error: "path is required" });
    try {
      const absPath = fileAccessService.resolveFromDir(record.dir, requestedPath);
      if (!statSync(absPath).isFile()) return res.status(400).json({ error: "not a file" });
      res.status(201).json({ event: sessions.preview(record.id, absPath, resolveUsername(req) ?? undefined) });
    } catch (err) {
      const { status, message } = fileAccessService.fileErrorResponse(err);
      res.status(status).json({ error: message });
    }
  });

  // Render an HTML artifact as a real page while keeping it isolated from the
  // dashboard origin. A base URL lets ordinary relative CSS/JS/image assets
  // resolve through the companion asset route below. The response-level CSP
  // sandbox also applies if someone opens this URL outside our iframe.
  app.get("/api/v1/sessions/:id/file/web", (req, res) => {
    const record = sessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: "unknown session" });
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    if (!subpath) return res.status(400).json({ error: "path is required" });
    try {
      const absPath = fileAccessService.resolveFromDir(record.dir, subpath);
      if (!statSync(absPath).isFile()) return res.status(400).json({ error: "not a file" });
      if (!/\.html?$/i.test(absPath)) return res.status(415).json({ error: "not an HTML file" });
      const rootToken = Buffer.from(path.dirname(absPath)).toString("base64url");
      const baseHref = `/api/v1/sessions/${encodeURIComponent(record.id)}/file/web-assets/${rootToken}/`;
      let html = readFileSync(absPath, "utf8");
      // The artifact's own base usually points at its production root. Replace
      // it with the preview bundle base rather than leaving two competing tags.
      html = html.replace(/<base\b[^>]*>/gi, "");
      // Root-relative HTML attributes would otherwise jump to the control API
      // origin. Keep them inside this preview bundle. Runtime-generated URLs
      // still obey normal browser/CORS behavior.
      html = html.replace(/(\b(?:src|href)=["'])\/(?!\/)([^"']*)/gi, `$1${baseHref}$2`);
      // The artifact is an entry document, so client-side routers should see
      // `/` rather than Peon's internal preview endpoint. The explicit base
      // still keeps relative assets on the preview bundle route.
      const base = `<base href="${baseHref}"><script>history.replaceState(null, "", "/")</script>`;
      html = /<head(?:\s[^>]*)?>/i.test(html)
        ? html.replace(/<head((?:\s[^>]*)?)>/i, `<head$1>${base}`)
        : `${base}${html}`;
      res.setHeader(
        "Content-Security-Policy",
        "sandbox allow-scripts allow-forms allow-modals allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * data: blob: ws: wss:",
      );
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.type("html").send(html);
    } catch (err) {
      const { status, message } = fileAccessService.fileErrorResponse(err);
      res.status(status).json({ error: message });
    }
  });

  app.get("/api/v1/sessions/:id/file/web-assets/:root/{*rest}", (req, res) => {
    if (!sessions.get(req.params.id)) return res.status(404).json({ error: "unknown session" });
    try {
      const root = Buffer.from(req.params.root, "base64url").toString("utf8");
      const segments = (req.params.rest as unknown as string[] | undefined) ?? [];
      const absPath = fileAccessService.resolveFromDir(root, segments.join("/"));
      if (!statSync(absPath).isFile()) return res.status(400).json({ error: "not a file" });
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(absPath);
    } catch (err) {
      const { status, message } = fileAccessService.fileErrorResponse(err);
      res.status(status).json({ error: message });
    }
  });

  // Raw bytes for formats the viewer/browser can render directly. Potentially
  // active formats (HTML/SVG/unknown text) deliberately fall back to
  // application/octet-stream; source text itself uses the JSON /file route.
  app.get("/api/v1/sessions/:id/file/raw", (req, res) => {
    const record = sessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: "unknown session" });
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    if (!subpath) return res.status(400).json({ error: "path is required" });
    const safeInlineTypes: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".ico": "image/x-icon",
      ".pdf": "application/pdf",
    };
    const contentType = safeInlineTypes[path.extname(subpath).toLowerCase()] ?? "application/octet-stream";
    try {
      const absPath = fileAccessService.resolveFromDir(record.dir, subpath);
      if (!statSync(absPath).isFile()) return res.status(400).json({ error: "not a file" });
      res.setHeader("Content-Type", contentType);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", "no-store");
      res.sendFile(absPath);
    } catch (err) {
      const { status, message } = fileAccessService.fileErrorResponse(err);
      res.status(status).json({ error: message });
    }
  });

  // Notify the viewer when its selected file changes. Watch the parent
  // directory, not the file descriptor: patch tools commonly save by
  // atomically replacing the file, which invalidates direct file watchers.
  app.get("/api/v1/sessions/:id/file/stream", (req, res) => {
    const record = sessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: "unknown session" });
    const subpath = typeof req.query.path === "string" ? req.query.path : "";
    if (!subpath) return res.status(400).json({ error: "path is required" });

    let absPath: string;
    try {
      absPath = fileAccessService.resolveFromDir(record.dir, subpath);
    } catch (err) {
      const { status, message } = fileAccessService.fileErrorResponse(err);
      return res.status(status).json({ error: message });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const filename = path.basename(absPath);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pushChanged = () => res.write(`event: changed\ndata: ${JSON.stringify({ path: subpath })}\n\n`);
    const schedule = (changed: string | Buffer | null) => {
      if (changed !== null && String(changed) !== filename) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        pushChanged();
      }, 150);
    };
    let watcher: ReturnType<typeof watch> | null = null;
    try {
      watcher = watch(path.dirname(absPath), (_eventType, changed) => schedule(changed));
      watcher.on("error", () => res.write(`event: failed\ndata: ${JSON.stringify({ error: "watch failed" })}\n\n`));
    } catch {
      res.write(`event: failed\ndata: ${JSON.stringify({ error: "watch failed" })}\n\n`);
    }
    req.on("close", () => {
      if (timer) clearTimeout(timer);
      watcher?.close();
    });
  });

  app.get("/api/v1/sessions/:id/stream", (req, res) => {
    if (!sessions.get(req.params.id)) return res.status(404).json({ error: "unknown session" });
    // Defensive — this route already sits behind the global auth-gate
    // middleware, which 401s before this handler ever runs, so this
    // shouldn't trigger in practice.
    const username = resolveUsername(req);
    if (!username) return res.status(401).json({ error: "not authenticated" });
    let resumeEventId: string | undefined;
    try {
      const lastEventIdHeader = req.headers["last-event-id"];
      resumeEventId = parseTranscriptResumeEventId(
        typeof lastEventIdHeader === "string" ? lastEventIdHeader : req.query.afterEventId,
      );
    } catch (error) {
      if (error instanceof TranscriptPaginationError) {
        return res.status(400).json({ error: error.message, code: error.code });
      }
      throw error;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();
    res.on("error", () => {});
    let closed = false;
    const send = (event: string, data: unknown, eventId?: string) => {
      if (closed) return;
      const idLine = eventId === undefined ? "" : `id: ${eventId}\n`;
      try {
        res.write(`event: ${event}\n${idLine}data: ${JSON.stringify(data)}\n\n`);
      } catch {
        closed = true;
      }
    };
    // The SSE id is the same immutable id returned on paginated snapshot
    // events, so snapshot/live overlap can be merged without payload guesses.
    const onEvent = (payload: { sessionId: string; event: unknown; eventId: string }) => {
      if (payload.sessionId === req.params.id) send("event", payload.event, payload.eventId);
    };
    const onChange = (record: SessionRecord) => {
      if (record.id === req.params.id) send("change", toPublicSessionRecord(record));
    };
    sessions.on("event", onEvent);
    sessions.on("change", onChange);

    // The dashboard fetches a bounded snapshot first, then supplies its newest
    // immutable id here. Subscribe before reading so events accepted during
    // this handoff are either in the replay snapshot or delivered live.
    if (resumeEventId !== undefined) {
      const transcript = sessions.getTranscriptEntries(req.params.id);
      const startAt = transcriptResumeIndex(transcript, resumeEventId);
      for (let i = startAt; i < transcript.length; i++) {
        send("event", transcript[i].event, transcript[i].id);
      }
    }

    // Presence: join immediately, send this connection its own initial
    // snapshot unconditionally (a second tab from the same user won't
    // trigger a "change" broadcast, but still needs its own first render),
    // then subscribe to future changes for this session. This connection's
    // own username is filtered out of every "viewers" payload — the badge is
    // for *other* viewers, so being the sole viewer of your own session
    // should show nothing (matches toSessionView's exclusion).
    const withoutSelf = (viewers: string[]) => viewers.filter((u) => u !== username);
    sessionPresence.join(req.params.id, username);
    send("presence", { viewers: withoutSelf(sessionPresence.list(req.params.id)) });
    const onPresenceChange = (payload: { sessionId: string; viewers: string[] }) => {
      if (payload.sessionId === req.params.id) send("presence", { viewers: withoutSelf(payload.viewers) });
    };
    sessionPresence.on("change", onPresenceChange);

    const heartbeat = setInterval(() => {
      if (closed) return;
      try {
        res.write(": ping\n\n");
      } catch {
        closed = true;
      }
    }, SSE_HEARTBEAT_MS);
    heartbeat.unref?.();

    req.on("close", () => {
      closed = true;
      clearInterval(heartbeat);
      sessions.off("event", onEvent);
      sessions.off("change", onChange);
      sessionPresence.off("change", onPresenceChange);
      sessionPresence.leave(req.params.id, username);
    });
  });

  // Dashboard-wide presence — who currently has the dashboard open at all,
  // on any page, not just a specific session's detail view. Reuses the same
  // sessionPresence store under a fixed pseudo-session key; opened once for
  // the lifetime of the app shell (see app.jsx) rather than per-view.
  app.get("/api/v1/presence/stream", (req, res) => {
    const username = resolveUsername(req);
    if (!username) return res.status(401).json({ error: "not authenticated" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    sessionPresence.join(DASHBOARD_PRESENCE_KEY, username);
    send("presence", { users: sessionPresence.list(DASHBOARD_PRESENCE_KEY) });
    const onPresenceChange = (payload: { sessionId: string; viewers: string[] }) => {
      if (payload.sessionId === DASHBOARD_PRESENCE_KEY) send("presence", { users: payload.viewers });
    };
    sessionPresence.on("change", onPresenceChange);

    req.on("close", () => {
      sessionPresence.off("change", onPresenceChange);
      sessionPresence.leave(DASHBOARD_PRESENCE_KEY, username);
    });
  });

  app.get("/api/v1/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("settings", settings.getControlSettingsView());
    const onChange = () => send("settings", settings.getControlSettingsView());
    settings.on("change", onChange);
    req.on("close", () => settings.off("change", onChange));
  });

  // express.json() otherwise lets malformed request bodies fall through to
  // Express's default HTML error page. Pairing clients need the same stable,
  // actionable JSON envelope for transport errors as for route validation.
  app.use((error: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (error instanceof SyntaxError && typeof error === "object" && error !== null && "body" in error) {
      return res.status(400).json({ error: "request body must be valid JSON", code: "BAD_REQUEST" });
    }
    next(error);
  });

  return app;
}
