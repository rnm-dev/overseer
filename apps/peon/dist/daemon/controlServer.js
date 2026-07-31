import { randomUUID } from "node:crypto";
import { readFileSync, statSync, watch } from "node:fs";
import { eventLoopDelayStats } from "./eventLoopMonitor.js";
import path from "node:path";
import express from "express";
import { settings } from "./settings/index.js";
import { sessionPresence } from "./sessionPresence.js";
import { sessionArtifactInventory, SessionOrchestrationService, sessions, toPublicSessionRecord, } from "./sessions/index.js";
import { createProjectService, projectStore } from "./projects/index.js";
import { updateChecker } from "./updateChecker.js";
import { createAgentRouter } from "./agentApi.js";
import { createHumanProjectsRouter } from "./http/human/projects.js";
import { createHumanSessionsRouter } from "./http/human/sessions.js";
import { createScopedMcpRouter } from "./scopedMcp.js";
import { modelCatalog, narrowNewSessionAgent, narrowModel, narrowReasoningEffort } from "./modelCatalog.js";
import { agentServices, getAgentDriver, listAgentDrivers } from "./agents/index.js";
import { startSelfUpdate } from "./selfUpdate.js";
import { attachHumanFilesystemRoutes } from "./http/human/files.js";
import { peonRegistrar, peonSocket } from "./overseer/index.js";
import { ArmoryMcpLifecycleService, ArmoryMcpRuntime, ArmoryUninstallService, createArmoryReadRouter, createArmoryStores } from "./armory/index.js";
import { FileAccessService, } from "./files/index.js";
import { toSessionSummary } from "./sessionSummary.js";
import { paginateTranscript, parseTranscriptPageRequest, parseTranscriptResumeEventId, transcriptResumeIndex, TranscriptPaginationError } from "./transcriptPagination.js";
import { analyticsForSessions, parseSessionAnalyticsQuery, SessionAnalyticsQueryError } from "./sessionAnalytics.js";
import { cliUpdates, CliUpdateError } from "./cliUpdates.js";
import { ClaimHttpError, peonClaimClient } from "./enrollment/index.js";
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
function toSessionView(record, viewerUsername) {
    const viewers = sessionPresence.list(record.id).filter((u) => u !== viewerUsername);
    return { ...toPublicSessionRecord(record), viewers, viewerCount: viewers.length };
}
function isLoopback(req) {
    const addr = req.socket.remoteAddress;
    return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}
const CLI_ACTOR = "local-cli";
export function createControlServer(options = {}) {
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
    const sessionProjectContract = {
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
            providers: modelCatalog(current.defaultAgent, current.ai.defaultModel, current.ai.defaultReasoningEffort).map(({ agent, label, models, reasoningEfforts, available }) => ({
                agent, label, models, reasoningEfforts, available,
            })),
        };
    });
    const sessionService = options.sessionService ?? sessions;
    const sessionHelpers = options.sessionHelpers ?? {
        toSessionSummary,
        toPublicSessionRecord,
        toSessionView,
        resolveSessionAuthor: () => CLI_ACTOR,
        resolveSessionViewer: () => CLI_ACTOR,
        resolveDefaultAgent: () => settings.get().defaultAgent,
        listAgentsForNewSessionError: () => listAgentDrivers({ visible: true, available: true }).map((driver) => driver.id).join(", "),
        narrowNewSessionAgent: narrowNewSessionAgent,
        narrowModel: narrowModel,
        narrowReasoningEffort: narrowReasoningEffort,
    };
    app.use(express.json());
    app.use((req, res, next) => {
        res.header("Access-Control-Allow-Methods", "GET,PATCH,POST,DELETE");
        res.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Peon-Actor, Peon-Protocol, Peon-Request-Id");
        if (req.method === "OPTIONS")
            return res.sendStatus(204);
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
        const fleetRequest = req.path === "/enroll" ||
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
                if (!res.headersSent)
                    res.status(404).json({ error: "not found", code: "NOT_FOUND" });
            });
        }
        next();
    });
    // Local coding agents use enabled Armory MCP packages. Mounted before the
    // dashboard cookie gate because the MCP router has a stricter boundary of
    // its own: genuine loopback, no browser Origin, and a loopback Host header.
    app.use("/mcp", createScopedMcpRouter({ armoryRuntime, projectService, sessionOrchestration }));
    app.use((req, res, next) => {
        if (isLoopback(req))
            return next();
        return res.status(403).json({
            error: "Peon local API is CLI-only; use Overseer for operator access",
            code: "LOCAL_ONLY",
        });
    });
    app.use("/api/v1/armory", createArmoryReadRouter(options.armoryInventory, {
        ...armoryApi,
        allowMutations: true,
    }));
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
            // Cheap piggyback so the sidebar can render its "AI" warning dot off
            // the poll it's already subscribed to — full detail lives in
            // GET /api/v1/ai/claude-code/status.
            claudeCodeAuthState: getAgentDriver("claude-code")?.services.status?.()?.authState,
            // Live fleet-link state for the Overseer view + sidebar warn dot, off the
            // same poll. `enabled` reflects whether overseerUrl+overseerToken are set;
            // `derecruited` (a revoked credential) is what the sidebar flags.
            overseer: { ...peonRegistrar.getState(), socket: peonSocket.getState() },
            enrollment: peonClaimClient.getStatus(),
            eventLoopDelay: eventLoopDelayStats(),
        });
    });
    app.use("/api/v1", createHumanProjectsRouter({
        projectService,
        resolveCreateActor: () => CLI_ACTOR,
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
        }
        catch (error) {
            if (error.code === "BAD_REQUEST") {
                return res.status(400).json({ error: error.error, code: "BAD_REQUEST" });
            }
            throw error;
        }
    });
    // Explicit legacy compatibility arm. Normal `peon pair <origin>` starts the
    // outbound claim endpoint below and reaches this mode only after an explicit
    // unsupported capability response.
    app.post("/api/v1/pairing/arm", (_req, res) => {
        try {
            const { phrase, expiresAt } = peonClaimClient.armLegacy();
            res.json({ ok: true, phrase, expiresAt });
        }
        catch (error) {
            const status = error instanceof ClaimHttpError ? error.status : 500;
            const code = error instanceof ClaimHttpError ? error.body?.code ?? error.message : "INTERNAL";
            res.status(status).json({ ok: false, code, error: code });
        }
    });
    app.get("/api/v1/enrollment/claim", (_req, res) => {
        res.json(peonClaimClient.getStatus());
    });
    app.post("/api/v1/enrollment/claim", async (req, res) => {
        try {
            const serverOrigin = typeof req.body?.serverOrigin === "string" ? req.body.serverOrigin : "";
            res.json(await peonClaimClient.begin(serverOrigin));
        }
        catch (error) {
            const status = error instanceof ClaimHttpError ? error.status : 400;
            const code = error instanceof ClaimHttpError ? error.body?.code ?? error.message : "BAD_REQUEST";
            res.status(status).json({ code, error: code });
        }
    });
    app.post("/api/v1/enrollment/claim/cancel", async (_req, res) => {
        try {
            res.json(await peonClaimClient.cancel());
        }
        catch (error) {
            const status = error instanceof ClaimHttpError ? error.status : 503;
            const code = error instanceof ClaimHttpError ? error.body?.code ?? error.message : "PERSIST_FAILED";
            res.status(status).json({ code, error: code });
        }
    });
    app.post("/api/v1/enrollment/retry", (_req, res) => {
        try {
            res.json(peonClaimClient.resumeParked());
        }
        catch {
            res.status(503).json({ code: "PERSIST_FAILED", error: "PERSIST_FAILED" });
        }
    });
    app.post("/api/v1/enrollment/credential/rotate", async (_req, res) => {
        try {
            res.json(await peonClaimClient.rotate());
        }
        catch (error) {
            const status = error instanceof ClaimHttpError ? error.status : 503;
            const code = error instanceof ClaimHttpError ? error.body?.code ?? error.message : "PERSIST_FAILED";
            res.status(status).json({ code, error: code });
        }
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
        res.json(sessions.statsForPeriod(period));
    });
    app.get("/api/v1/ai/analytics", (req, res) => {
        try {
            const query = parseSessionAnalyticsQuery(req.query);
            res.json(analyticsForSessions(sessions.list(), query, sessionArtifactInventory()));
        }
        catch (error) {
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
        if (!driver)
            return res.status(404).json({ error: "unknown status provider" });
        res.json(driver.services.status?.() ?? null);
    });
    app.get("/api/v1/ai/cli-updates", async (req, res) => {
        res.json(await cliUpdateService.get(undefined, req.query.refresh === "1"));
    });
    app.get("/api/v1/ai/cli-updates/:provider", async (req, res) => {
        const provider = req.params.provider;
        if (!getAgentDriver(provider)?.capabilities.cliUpdate)
            return res.status(404).json({ error: "unknown CLI provider", code: "UNKNOWN_PROVIDER" });
        res.json((await cliUpdateService.get(provider, req.query.refresh === "1")).providers[0]);
    });
    app.post("/api/v1/ai/cli-updates/:provider", async (req, res) => {
        const provider = req.params.provider;
        if (!getAgentDriver(provider)?.capabilities.cliUpdate)
            return res.status(404).json({ error: "unknown CLI provider", code: "UNKNOWN_PROVIDER" });
        try {
            res.status(202).json({ provider, operation: await cliUpdateService.start(provider) });
        }
        catch (error) {
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
        const provider = req.params.provider;
        if (!getAgentDriver(provider)?.capabilities.quota)
            return res.status(404).json({ error: "unknown quota provider" });
        res.json(await agentServices.quota(provider, req.query.refresh === "1"));
    });
    app.get("/api/v1/ai/capabilities", async (req, res) => {
        res.json(await agentServices.allCapabilities(req.query.refresh === "1"));
    });
    app.get("/api/v1/ai/capabilities/:provider", async (req, res) => {
        const provider = req.params.provider;
        if (!getAgentDriver(provider))
            return res.status(404).json({ error: "unknown capabilities provider" });
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
        if (!sessions.get(req.params.id))
            return res.status(404).json({ error: "unknown session" });
        try {
            const pagination = parseTranscriptPageRequest(req.query.limit, req.query.cursor);
            if (!pagination)
                return res.json({ events: sessions.getTranscript(req.params.id) });
            res.json(paginateTranscript(req.params.id, sessions.getTranscriptEntries(req.params.id), pagination));
        }
        catch (error) {
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
        if (!record)
            return res.status(404).json({ error: "unknown session" });
        const subpath = typeof req.query.path === "string" ? req.query.path : "";
        try {
            const absDir = fileAccessService.resolveFromDir(record.dir, subpath);
            res.json({ path: absDir, entries: fileAccessService.listDirEntries(absDir, absDir) });
        }
        catch (err) {
            const { status, message } = fileAccessService.dirErrorResponse(err);
            res.status(status).json({ error: message });
        }
    });
    app.get("/api/v1/sessions/:id/file", (req, res) => {
        const record = sessions.get(req.params.id);
        if (!record)
            return res.status(404).json({ error: "unknown session" });
        const subpath = typeof req.query.path === "string" ? req.query.path : "";
        if (!subpath)
            return res.status(400).json({ error: "path is required" });
        try {
            const absPath = fileAccessService.resolveFromDir(record.dir, subpath);
            res.json({ ...fileAccessService.readFileView(absPath), path: absPath });
        }
        catch (err) {
            const { status, message } = fileAccessService.fileErrorResponse(err);
            res.status(status).json({ error: message });
        }
    });
    app.post("/api/v1/sessions/:id/preview", (req, res) => {
        const record = sessions.get(req.params.id);
        if (!record)
            return res.status(404).json({ error: "unknown session" });
        const requestedPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
        if (!requestedPath)
            return res.status(400).json({ error: "path is required" });
        try {
            const absPath = fileAccessService.resolveFromDir(record.dir, requestedPath);
            if (!statSync(absPath).isFile())
                return res.status(400).json({ error: "not a file" });
            res.status(201).json({ event: sessions.preview(record.id, absPath, CLI_ACTOR) });
        }
        catch (err) {
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
        if (!record)
            return res.status(404).json({ error: "unknown session" });
        const subpath = typeof req.query.path === "string" ? req.query.path : "";
        if (!subpath)
            return res.status(400).json({ error: "path is required" });
        try {
            const absPath = fileAccessService.resolveFromDir(record.dir, subpath);
            if (!statSync(absPath).isFile())
                return res.status(400).json({ error: "not a file" });
            if (!/\.html?$/i.test(absPath))
                return res.status(415).json({ error: "not an HTML file" });
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
            res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-forms allow-modals allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; connect-src * data: blob: ws: wss:");
            res.setHeader("Referrer-Policy", "no-referrer");
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.type("html").send(html);
        }
        catch (err) {
            const { status, message } = fileAccessService.fileErrorResponse(err);
            res.status(status).json({ error: message });
        }
    });
    app.get("/api/v1/sessions/:id/file/web-assets/:root/{*rest}", (req, res) => {
        if (!sessions.get(req.params.id))
            return res.status(404).json({ error: "unknown session" });
        try {
            const root = Buffer.from(req.params.root, "base64url").toString("utf8");
            const segments = req.params.rest ?? [];
            const absPath = fileAccessService.resolveFromDir(root, segments.join("/"));
            if (!statSync(absPath).isFile())
                return res.status(400).json({ error: "not a file" });
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
            res.setHeader("Cache-Control", "no-store");
            res.sendFile(absPath);
        }
        catch (err) {
            const { status, message } = fileAccessService.fileErrorResponse(err);
            res.status(status).json({ error: message });
        }
    });
    // Raw bytes for formats the viewer/browser can render directly. Potentially
    // active formats (HTML/SVG/unknown text) deliberately fall back to
    // application/octet-stream; source text itself uses the JSON /file route.
    app.get("/api/v1/sessions/:id/file/raw", (req, res) => {
        const record = sessions.get(req.params.id);
        if (!record)
            return res.status(404).json({ error: "unknown session" });
        const subpath = typeof req.query.path === "string" ? req.query.path : "";
        if (!subpath)
            return res.status(400).json({ error: "path is required" });
        const safeInlineTypes = {
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
            if (!statSync(absPath).isFile())
                return res.status(400).json({ error: "not a file" });
            res.setHeader("Content-Type", contentType);
            res.setHeader("X-Content-Type-Options", "nosniff");
            res.setHeader("Cache-Control", "no-store");
            res.sendFile(absPath);
        }
        catch (err) {
            const { status, message } = fileAccessService.fileErrorResponse(err);
            res.status(status).json({ error: message });
        }
    });
    // Notify the viewer when its selected file changes. Watch the parent
    // directory, not the file descriptor: patch tools commonly save by
    // atomically replacing the file, which invalidates direct file watchers.
    app.get("/api/v1/sessions/:id/file/stream", (req, res) => {
        const record = sessions.get(req.params.id);
        if (!record)
            return res.status(404).json({ error: "unknown session" });
        const subpath = typeof req.query.path === "string" ? req.query.path : "";
        if (!subpath)
            return res.status(400).json({ error: "path is required" });
        let absPath;
        try {
            absPath = fileAccessService.resolveFromDir(record.dir, subpath);
        }
        catch (err) {
            const { status, message } = fileAccessService.fileErrorResponse(err);
            return res.status(status).json({ error: message });
        }
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        const filename = path.basename(absPath);
        let timer = null;
        const pushChanged = () => res.write(`event: changed\ndata: ${JSON.stringify({ path: subpath })}\n\n`);
        const schedule = (changed) => {
            if (changed !== null && String(changed) !== filename)
                return;
            if (timer)
                return;
            timer = setTimeout(() => {
                timer = null;
                pushChanged();
            }, 150);
        };
        let watcher = null;
        try {
            watcher = watch(path.dirname(absPath), (_eventType, changed) => schedule(changed));
            watcher.on("error", () => res.write(`event: failed\ndata: ${JSON.stringify({ error: "watch failed" })}\n\n`));
        }
        catch {
            res.write(`event: failed\ndata: ${JSON.stringify({ error: "watch failed" })}\n\n`);
        }
        req.on("close", () => {
            if (timer)
                clearTimeout(timer);
            watcher?.close();
        });
    });
    app.get("/api/v1/sessions/:id/stream", (req, res) => {
        if (!sessions.get(req.params.id))
            return res.status(404).json({ error: "unknown session" });
        // Defensive — this route already sits behind the global auth-gate
        // middleware, which 401s before this handler ever runs, so this
        // shouldn't trigger in practice.
        const username = CLI_ACTOR;
        let resumeEventId;
        try {
            const lastEventIdHeader = req.headers["last-event-id"];
            resumeEventId = parseTranscriptResumeEventId(typeof lastEventIdHeader === "string" ? lastEventIdHeader : req.query.afterEventId);
        }
        catch (error) {
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
        res.on("error", () => { });
        let closed = false;
        const send = (event, data, eventId) => {
            if (closed)
                return;
            const idLine = eventId === undefined ? "" : `id: ${eventId}\n`;
            try {
                res.write(`event: ${event}\n${idLine}data: ${JSON.stringify(data)}\n\n`);
            }
            catch {
                closed = true;
            }
        };
        // The SSE id is the same immutable id returned on paginated snapshot
        // events, so snapshot/live overlap can be merged without payload guesses.
        const onEvent = (payload) => {
            if (payload.sessionId === req.params.id)
                send("event", payload.event, payload.eventId);
        };
        const onChange = (record) => {
            if (record.id === req.params.id)
                send("change", toPublicSessionRecord(record));
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
        const withoutSelf = (viewers) => viewers.filter((u) => u !== username);
        sessionPresence.join(req.params.id, username);
        send("presence", { viewers: withoutSelf(sessionPresence.list(req.params.id)) });
        const onPresenceChange = (payload) => {
            if (payload.sessionId === req.params.id)
                send("presence", { viewers: withoutSelf(payload.viewers) });
        };
        sessionPresence.on("change", onPresenceChange);
        const heartbeat = setInterval(() => {
            if (closed)
                return;
            try {
                res.write(": ping\n\n");
            }
            catch {
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
    app.get("/api/v1/events", (req, res) => {
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        const send = (event, data) => {
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
    app.use((error, _req, res, next) => {
        if (error instanceof SyntaxError && typeof error === "object" && error !== null && "body" in error) {
            return res.status(400).json({ error: "request body must be valid JSON", code: "BAD_REQUEST" });
        }
        next(error);
    });
    return app;
}
