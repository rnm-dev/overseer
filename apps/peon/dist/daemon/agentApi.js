import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fsPromises, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { eventLoopDelayStats } from "./eventLoopMonitor.js";
import path from "node:path";
import express from "express";
import { DaemonConfigurationState, settings } from "./settings/index.js";
import { sessionArtifactInventory, sessions, toPublicSessionRecord, } from "./sessions/index.js";
import { createProjectService, projectStore } from "./projects/index.js";
import { pairing } from "./pairing.js";
import { ensurePeonId } from "./peonIdentity.js";
import { peonPublicUrl } from "./peonAddress.js";
import { modelCatalog } from "./modelCatalog.js";
import { agentServices, configureManagedPluginToolHandler, getAgentDriver, getAgentServiceDriver, getCodexAppServerRuntime } from "./agents/index.js";
import { ManagedPluginInquiryError, ManagedPluginInquiryService, MANAGED_PLUGIN_INQUIRY_CAPABILITY, } from "./managedPluginInquiries.js";
import { updateChecker } from "./updateChecker.js";
import { applyUpdate, checkUpdate, updateOperationStatus } from "./updateOperations.js";
import { createArmoryReadRouter } from "./armory/index.js";
import { FileAccessService } from "./files/index.js";
import { parseTranscriptPageRequest, parseTranscriptResumeEventId, transcriptResumeIndex, TranscriptPaginationError } from "./transcriptPagination.js";
import { analyticsForSessions, parseSessionAnalyticsQuery, SessionAnalyticsQueryError } from "./sessionAnalytics.js";
import { attachProjectRoutes } from "./http/fleet/projects.js";
import { attachSessionRoutes } from "./http/fleet/sessions.js";
import { attachFleetProjectFileRoutes } from "./http/fleet/files.js";
import { attachFleetSessionFileRoutes } from "./http/fleet/sessionFiles.js";
import { PROTOCOL_VERSION } from "./protocol.js";
import { UnauthorizedRateLimiter } from "./unauthorizedRateLimit.js";
// The machine-facing control surface a "overseer" (fleet control plane) uses
// to drive this peon — see PROTOCOL.md. It is deliberately a *separate* router
// from the human `/api/v1/*` surface in controlServer.ts: its own auth (a shared
// bearer token), its own version handle
// (`/api/v1`), and none of the human-only presence bookkeeping. It is mounted
// ahead of the local-only gate so its bearer check is the only thing standing
// in front of it.
//
// Everything here reuses the same underlying stores (sessions, settings) the
// human handlers call — this is a second door onto the same house, not a second
// house.
export { PROTOCOL_VERSION } from "./protocol.js";
// SSE keep-alive comment interval for GET /sessions/:id/stream — at least
// every 15s so a half-open connection through an idle-timing proxy gets
// noticed (see PROTOCOL.md). Overridable via env so tests can assert
// heartbeats arrive without waiting out the real interval.
const SSE_HEARTBEAT_MS = Number(process.env.ACA_SSE_HEARTBEAT_MS) || 15_000;
// Accepted ?period= values for GET /stats — mirrors the human /api/v1/ai/stats.
const STATS_PERIODS = ["day", "yesterday", "week", "month"];
// Fleet HTTP owns configuration reads and mutations. Create the durable
// optimistic-concurrency fence only after module initialization completes;
// settings and model discovery intentionally share an import cycle.
let daemonConfigurationState;
function configurationState() {
    return daemonConfigurationState ??= new DaemonConfigurationState();
}
const managedPluginInquiries = new ManagedPluginInquiryService(undefined, () => sessions.list());
configureManagedPluginToolHandler(async (params, generation) => {
    const runtime = getCodexAppServerRuntime(settings.get().codexCommand);
    managedPluginInquiries.bindRuntime(runtime);
    return managedPluginInquiries.handleDynamicToolCall(params, generation);
});
export async function requestManagedPluginInstall(sessionId, pluginId) {
    const session = sessions.get(sessionId);
    const runtime = getCodexAppServerRuntime(settings.get().codexCommand);
    managedPluginInquiries.bindRuntime(runtime);
    if (!session?.backendSessionId || !session.backendTurnId || session.backendRuntimeGeneration === null) {
        return { contentItems: [{ type: "inputText", text: "The originating session turn is not active." }], success: false };
    }
    return managedPluginInquiries.handleDynamicToolCall({
        threadId: session.backendSessionId,
        turnId: session.backendTurnId,
        tool: "request_plugin_install",
        arguments: { plugin_id: pluginId },
    }, session.backendRuntimeGeneration);
}
function fail(res, status, code, error) {
    res.status(status).json({ error, code });
}
function failFilesystemRead(res, err) {
    const code = err.code;
    if (code === "EACCES" || code === "EPERM") {
        return fail(res, 403, "FORBIDDEN", "filesystem path is not readable");
    }
    if (code === "ENOENT" || code === "ENOTDIR") {
        return fail(res, 404, "NOT_FOUND", "filesystem directory was not found");
    }
    if (code === "ELOOP" || code === "EINVAL" || code === "ENAMETOOLONG") {
        return fail(res, 400, "INVALID_PATH", "filesystem path is invalid");
    }
    return fail(res, 500, "INTERNAL", "failed to read filesystem directory");
}
// Constant-time token comparison — a plain `===` leaks length/prefix timing.
function tokenMatches(provided, expected) {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}
function normalizeOverseerUrl(raw) {
    if (!raw)
        return { error: "overseerUrl is required" };
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return { error: "overseerUrl must be a complete http:// or https:// URL" };
    }
    if (!["http:", "https:"].includes(url.protocol)) {
        return { error: "overseerUrl must use http:// or https://" };
    }
    if (!url.hostname)
        return { error: "overseerUrl must include a hostname" };
    if (url.username || url.password)
        return { error: "overseerUrl must not contain a username or password" };
    if (url.search || url.hash)
        return { error: "overseerUrl must not contain a query string or fragment" };
    return { url: url.toString().replace(/\/$/, "") };
}
// Rate-limit /enroll to blunt online guessing of the (memorable, lower-entropy)
// pairing phrase — a sliding 60s window per source IP. Tailnet-only exposure,
// the short TTL, one-time use and this limit jointly bound online guessing. Only rejected bearer credentials
// count: once the caller has proved it knows the phrase, correcting a malformed
// URL must not unexpectedly lock a legitimate operator out.
const ENROLL_WINDOW_MS = 60_000;
const ENROLL_MAX_ATTEMPTS = 5;
const enrollAttempts = new Map();
function enrollRateLimited(ip) {
    const now = Date.now();
    const recent = (enrollAttempts.get(ip) ?? []).filter((t) => now - t < ENROLL_WINDOW_MS);
    enrollAttempts.set(ip, recent);
    // Opportunistic prune so the map can't grow unbounded across many peers.
    if (enrollAttempts.size > 1_000) {
        for (const [k, v] of enrollAttempts) {
            if (v.every((t) => now - t >= ENROLL_WINDOW_MS))
                enrollAttempts.delete(k);
        }
    }
    return recent.length >= ENROLL_MAX_ATTEMPTS;
}
function recordRejectedEnrollmentCredential(ip) {
    const attempts = enrollAttempts.get(ip) ?? [];
    attempts.push(Date.now());
    enrollAttempts.set(ip, attempts);
}
// Resolve a URL path (already split into decoded segments by Express 5's
// `{*rest}`) against the sandbox root, returning null if it escapes. This is the
// only thing standing between the overseer and the rest of the filesystem, so
// it resolves *then* containment-checks the normalized absolute path — a `..`
// segment normalizes before the check, so traversal can't slip through.
function resolveInRoot(root, segments) {
    const rootAbs = path.resolve(root);
    const abs = path.resolve(rootAbs, segments.join("/"));
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep))
        return null;
    return abs;
}
function hashFile(abs) {
    return new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        createReadStream(abs)
            .on("error", reject)
            .on("data", (chunk) => hash.update(chunk))
            .on("end", () => resolve(hash.digest("hex")));
    });
}
// Keep the fleet error envelope at the transport boundary while the shared
// project service owns validation and state changes for both API profiles.
function agentStatusView() {
    return {
        protocol: PROTOCOL_VERSION,
        name: settings.get().name || null,
        paused: settings.get().paused,
        activeSessionCount: sessions.activeCount(),
        sessionCount: sessions.list().length,
        filesEnabled: Boolean(settings.get().fileTransferRoot),
        capabilities: [MANAGED_PLUGIN_INQUIRY_CAPABILITY],
        agentAuth: (() => {
            const s = getAgentDriver("claude-code")?.services.status?.();
            return { authState: s?.authState, available: s?.available, checkedAt: s?.checkedAt };
        })(),
        ...updateStatusView(),
        uptimeSec: Math.floor(process.uptime()),
        eventLoopDelay: eventLoopDelayStats(),
    };
}
function updateStatusView() {
    const updateState = updateChecker.getState();
    return {
        updateAvailable: updateState.updateAvailable,
        updateCurrentVersion: updateState.currentVersion,
        updateLatestVersion: updateState.latestVersion,
        updateCurrentRevision: updateState.currentRevision,
        updateLatestRevision: updateState.latestRevision,
        updateCheckedAt: updateState.checkedAt,
        updateCheckError: updateState.error,
    };
}
export function createAgentRouter(options = {}) {
    const router = express.Router();
    const unauthorizedRateLimiter = options.unauthorizedRateLimiter ?? new UnauthorizedRateLimiter();
    const sessionProjectContract = {
        list: () => sessions.list(),
        renameProjectKey: (oldKey, newKey) => sessions.renameProjectKey(oldKey, newKey),
        start: (sessionOptions) => sessions.start(sessionOptions),
        rename: (id, title) => sessions.rename(id, title),
    };
    const fileAccessService = options.fileAccessService ?? new FileAccessService();
    const projectService = options.projectService ?? createProjectService(projectStore, sessionProjectContract);
    const projectFileReader = options.projectFileReader ?? { get: (key) => projectStore.get(key) };
    const sessionProjectReader = options.sessionProjectReader ?? {
        list: () => sessions.list(),
    };
    const sessionService = options.sessionService ?? {
        list: () => sessions.list(),
        page: (options) => sessions.page(options),
        get: (id) => sessions.get(id),
        rename: (id, title) => sessions.rename(id, title),
        start: (sessionOptions) => sessions.start(sessionOptions),
        branch: (id, branchOptions) => sessions.branch(id, branchOptions),
        resume: (id, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId) => sessions.resume(id, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId),
        enqueue: (id, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId, startNow) => sessions.enqueue(id, prompt, attachments, permissionMode, author, model, reasoningEffort, commandId, startNow),
        queued: (id) => sessions.queued(id),
        editQueued: (id, itemId, prompt) => sessions.editQueued(id, itemId, prompt),
        steerQueued: (id, itemId) => sessions.steerQueued(id, itemId),
        sendQueuedNow: (id, itemId) => sessions.sendQueuedNow(id, itemId),
        removeQueued: (id, itemId) => sessions.removeQueued(id, itemId),
        cancel: (id) => sessions.cancel(id),
        delete: (id) => sessions.delete(id),
    };
    const sessionRouterDeps = {
        sessions: sessionService,
        getFileTransferRoot: options.getFileTransferRoot ?? (() => settings.get().fileTransferRoot),
        defaultAgent: options.defaultAgent ?? settings.get().defaultAgent,
    };
    const sessionFiles = options.sessionFiles ?? {
        get: (id) => sessions.get(id),
        preview: (id, filePath, author) => sessions.preview(id, filePath, author),
    };
    // --- recruitment ---------------------------------------------------------
    // The one /api/v1 route reachable with *no* overseerToken set — so a fresh,
    // never-recruited peon can be handed its first credential (the rest of the
    // surface stays 503'd off until overseerToken exists). Authorized by the armed
    // single-use pairing phrase (boot / `peon pair`) OR the current overseerToken
    // (an already-recruited overseer re-pointing this peon at a new workspace).
    // Registered ahead of the auth middleware below so that gate never runs for it.
    // See PROTOCOL.md "Recruitment".
    router.post("/enroll", (req, res) => {
        const ip = req.socket.remoteAddress ?? "unknown";
        if (enrollRateLimited(ip)) {
            return fail(res, 429, "RATE_LIMITED", "too many enroll attempts — slow down");
        }
        const proto = req.headers["peon-protocol"];
        if (proto !== undefined && String(proto).split(".")[0] !== String(PROTOCOL_VERSION)) {
            return fail(res, 400, "UNSUPPORTED_PROTOCOL", `unsupported Peon-Protocol ${proto} (this peon speaks ${PROTOCOL_VERSION})`);
        }
        const reqId = req.headers["peon-request-id"];
        if (typeof reqId === "string" && reqId)
            res.setHeader("Peon-Request-Id", reqId);
        const authorization = req.headers.authorization?.trim() ?? "";
        const bearer = authorization.match(/^Bearer\s+(.+)$/i);
        if (!bearer) {
            return fail(res, 401, "UNAUTHENTICATED", "pairing phrase is required in Authorization: Bearer <phrase> — arm a new phrase on the peon and retry");
        }
        const provided = bearer[1].trim();
        const currentToken = settings.get().overseerToken;
        const byPairing = pairing.check(provided);
        const byToken = Boolean(currentToken) && tokenMatches(provided, currentToken);
        if (!byPairing && !byToken) {
            recordRejectedEnrollmentCredential(ip);
            const message = pairing.isArmed()
                ? "pairing phrase was not accepted — check the phrase and retry"
                : "pairing phrase is expired or already used — arm a new phrase on the peon and retry";
            return fail(res, 401, "UNAUTHENTICATED", message);
        }
        const rawOverseerUrl = typeof req.body?.overseerUrl === "string" ? req.body.overseerUrl.trim() : "";
        const overseerToken = typeof req.body?.overseerToken === "string" ? req.body.overseerToken.trim() : "";
        const normalized = normalizeOverseerUrl(rawOverseerUrl);
        if (normalized.error)
            return fail(res, 400, "BAD_REQUEST", `${normalized.error}; the pairing phrase was not consumed`);
        if (!overseerToken)
            return fail(res, 400, "BAD_REQUEST", "overseerToken is required; the pairing phrase was not consumed");
        const overseerUrl = normalized.url;
        // Return the same peonId the following register will use — the overseer binds
        // the minted credential to this id from the response, before we phone home.
        const peonId = ensurePeonId();
        // Persist atomically (same store as PATCH /api/v1/settings). This swaps the
        // agent-surface bearer to the new pn_ token *and* fires a settings `change`,
        // which the registrar and Peon socket watch so they reconnect immediately
        // (and lift any de-recruit stop) rather than waiting for the next tick.
        settings.update({ overseerUrl, overseerToken });
        // Single-use: burn the phrase so it can't be replayed. A token-authed
        // re-point leaves no phrase to burn.
        if (byPairing)
            pairing.burn();
        // publicUrl lets the overseer retain a configured DNS/reverse-proxy address
        // immediately. The URL entered by the operator remains authoritative; this
        // value is a canonical fallback and must never be replaced by the socket IP.
        res.json({ ok: true, peonId, publicUrl: peonPublicUrl() });
    });
    // --- auth + envelope -----------------------------------------------------
    router.use((req, res, next) => {
        const token = settings.get().overseerToken;
        if (!token) {
            return fail(res, 503, "AGENT_API_DISABLED", "the /agent API is disabled — set overseerToken to enable it");
        }
        const provided = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!provided || !tokenMatches(provided, token)) {
            const decision = unauthorizedRateLimiter.recordFailure(req.socket.remoteAddress);
            if (decision.limited) {
                res.setHeader("Retry-After", String(decision.retryAfterSeconds));
                return fail(res, 429, "RATE_LIMITED", "too many failed authorization attempts");
            }
            return fail(res, 401, "UNAUTHENTICATED", "missing or invalid bearer token");
        }
        const proto = req.headers["peon-protocol"];
        if (proto !== undefined && String(proto).split(".")[0] !== String(PROTOCOL_VERSION)) {
            return fail(res, 400, "UNSUPPORTED_PROTOCOL", `unsupported Peon-Protocol ${proto} (this peon speaks ${PROTOCOL_VERSION})`);
        }
        const actor = typeof req.headers["peon-actor"] === "string" ? req.headers["peon-actor"].trim() : "";
        req.actor = actor || null;
        // Echo the correlation id straight back so the overseer can tie a response
        // (including an error) to the request that produced it.
        const reqId = req.headers["peon-request-id"];
        if (typeof reqId === "string" && reqId)
            res.setHeader("Peon-Request-Id", reqId);
        next();
    });
    // --- health / load -------------------------------------------------------
    router.get("/status", (_req, res) => {
        res.json(agentStatusView());
    });
    // Convenient state mutation for control planes that model a peon as one
    // resource. /control/pause and /control/resume remain compatibility aliases.
    router.patch("/status", (req, res) => {
        if (typeof req.body?.paused !== "boolean") {
            return fail(res, 400, "BAD_REQUEST", "paused must be a boolean");
        }
        settings.update({ paused: req.body.paused });
        res.json(agentStatusView());
    });
    // The AI providers/models this peon can run a session on. The overseer reads
    // this to populate its per-peon model picker. Each models/reasoningEfforts
    // list identifies its default on the corresponding record. Model
    // validation is intentionally softer than this list (any well-formed claude-*
    // id is accepted) — see modelCatalog.isValidModel.
    router.get("/models", (_req, res) => {
        const s = settings.get();
        res.json({
            defaultAgent: s.defaultAgent,
            providers: modelCatalog(s.defaultAgent, s.ai.defaultModel, s.ai.defaultReasoningEffort),
        });
    });
    router.get("/sessions/:id/inquiries", (req, res) => {
        if (!sessions.get(req.params.id))
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        res.setHeader("Cache-Control", "no-store");
        res.json({ version: "inquiry-v1", inquiries: managedPluginInquiries.list(req.params.id) });
    });
    router.get("/sessions/:id/inquiries/:inquiryId", (req, res) => {
        try {
            res.setHeader("Cache-Control", "no-store");
            res.json(managedPluginInquiries.get(req.params.id, req.params.inquiryId));
        }
        catch (error) {
            if (error instanceof ManagedPluginInquiryError)
                return res.status(error.status).json({ error: error.message, code: error.code });
            throw error;
        }
    });
    router.post("/sessions/:id/inquiries/:inquiryId/respond", async (req, res) => {
        try {
            const actor = req.actor;
            if (!actor)
                return fail(res, 400, "BAD_REQUEST", "Peon-Actor is required");
            const action = req.body?.action;
            if (action !== "install" && action !== "cancel")
                return fail(res, 400, "BAD_REQUEST", "action must be install or cancel");
            res.setHeader("Cache-Control", "no-store");
            res.json(await managedPluginInquiries.respond(req.params.id, req.params.inquiryId, actor, action));
        }
        catch (error) {
            if (error instanceof ManagedPluginInquiryError)
                return res.status(error.status).json({ error: error.message, code: error.code });
            throw error;
        }
    });
    // Shared windows stay provider-level; scoped windows include modelIds.
    router.get("/quota", async (req, res) => {
        res.json(await agentServices.quotas(req.query.refresh === "1"));
    });
    router.get("/quota/:provider", async (req, res) => {
        const provider = req.params.provider;
        if (!getAgentServiceDriver(provider)?.capabilities.quota)
            return fail(res, 404, "NOT_FOUND", "unknown quota provider");
        res.json(await agentServices.quota(provider, req.query.refresh === "1"));
    });
    router.get("/capabilities", async (req, res) => {
        res.json(await agentServices.allCapabilities(req.query.refresh === "1"));
    });
    router.get("/capabilities/:provider", async (req, res) => {
        const provider = req.params.provider;
        if (!getAgentServiceDriver(provider))
            return fail(res, 404, "NOT_FOUND", "unknown capabilities provider");
        res.json(await agentServices.capabilities(provider, req.query.refresh === "1"));
    });
    router.use("/armory", createArmoryReadRouter(options.armoryInventory, {
        ...options.armoryApi,
        allowMutations: true,
    }));
    // Host filesystem directory browser for an authenticated Overseer. This is
    // intentionally outside both project and configured file sandboxes: the
    // Overseer bearer is an admin credential and may navigate from `/`, subject
    // only to this Peon process's OS permissions. The route never returns file
    // metadata or bytes and has no mutation-method siblings.
    router.use("/filesystem", (req, res, next) => {
        try {
            decodeURI(req.originalUrl.split("?", 1)[0]);
            next();
        }
        catch {
            fail(res, 400, "INVALID_PATH", "filesystem path contains a malformed segment");
        }
    });
    router.get(["/filesystem", "/filesystem/{*rest}"], async (req, res) => {
        if (req.query.stat !== "1") {
            return fail(res, 400, "BAD_REQUEST", "filesystem browsing requires ?stat=1");
        }
        const segments = req.params.rest ?? [];
        const requestedPath = path.resolve("/", segments.join("/"));
        try {
            // stat follows a directory symlink. This makes ordinary host navigation
            // useful while still applying the target's permissions to readdir below.
            const stat = await fsPromises.stat(requestedPath);
            if (!stat.isDirectory()) {
                return fail(res, 404, "NOT_FOUND", "filesystem directory was not found");
            }
            const dirents = await fsPromises.readdir(requestedPath, { withFileTypes: true });
            const entries = (await Promise.all(dirents.map(async (entry) => {
                if (entry.isDirectory())
                    return { name: entry.name, type: "directory" };
                if (!entry.isSymbolicLink())
                    return null;
                try {
                    const target = await fsPromises.stat(path.join(requestedPath, entry.name));
                    return target.isDirectory() ? { name: entry.name, type: "directory" } : null;
                }
                catch {
                    // Broken, cyclic, or otherwise unresolvable symlinks are omitted just
                    // like regular files. Directory access is checked when it is opened.
                    return null;
                }
            }))).filter((entry) => entry !== null);
            entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
            return res.json({ path: requestedPath, entries });
        }
        catch (err) {
            return failFilesystemRead(res, err);
        }
    });
    // --- projects ------------------------------------------------------------
    attachProjectRoutes(router, { projectService, sessionProjectReader });
    attachFleetProjectFileRoutes(router, {
        fileAccessService,
        projectReader: projectFileReader,
        openProjectUpload: options.openProjectUpload,
        moveProject: options.moveProjectFile,
    });
    // --- settings (operator-facing subset only) ------------------------------
    router.get("/settings", (_req, res) => {
        const snapshot = configurationState().reconcile().snapshot;
        res.json({
            ...snapshot.values,
            configuration: {
                epoch: snapshot.epoch,
                revision: snapshot.revision,
                digest: snapshot.digest,
                updatedAt: snapshot.updatedAt,
            },
        });
    });
    // Partial, allowlisted, validated update. Only name/defaultAgent/
    // fileTransferRoot/heartbeatIntervalMs/aiDefaultModel/soul/paused are editable here;
    // secrets and listen address are never accepted (the human PATCH /api/v1/settings is
    // unguarded; this fleet-facing one must not be). Absent keys are untouched;
    // unknown keys ignored. Reuses the same atomic write path (settings.update),
    // whose `change` event propagates the edit with no restart.
    router.patch("/settings", (req, res) => {
        try {
            const before = configurationState().reconcile().snapshot;
            const expectedEpoch = req.header("Peon-Configuration-Epoch");
            const expectedRevision = Number(req.header("Peon-Configuration-Revision"));
            const expectedDigest = req.header("Peon-Configuration-Digest");
            if (expectedEpoch !== before.epoch
                || !Number.isSafeInteger(expectedRevision)
                || expectedRevision !== before.revision
                || expectedDigest !== before.digest) {
                return res.status(409).json({
                    error: "configuration revision conflict",
                    code: "REVISION_CONFLICT",
                    configuration: {
                        epoch: before.epoch,
                        revision: before.revision,
                        digest: before.digest,
                        updatedAt: before.updatedAt,
                    },
                });
            }
            const { view } = settings.patchDaemonConfiguration(req.body ?? {});
            const after = configurationState().reconcile().snapshot;
            res.json({
                ...view,
                configuration: {
                    epoch: after.epoch,
                    revision: after.revision,
                    digest: after.digest,
                    updatedAt: after.updatedAt,
                },
                restart: { required: false, components: [] },
            });
        }
        catch (error) {
            if (error.code === "BAD_REQUEST") {
                return fail(res, 400, "BAD_REQUEST", error.error);
            }
            throw error;
        }
    });
    // --- usage / cost rollups ------------------------------------------------
    // Session outcome + token/cost/duration totals over a period, for the
    // control plane's own cost & load monitoring. Read-only; mirrors the human
    // GET /api/v1/ai/stats. ?period=day (default) | yesterday | week | month.
    router.get("/stats", (req, res) => {
        const period = typeof req.query.period === "string" ? req.query.period : "day";
        if (!STATS_PERIODS.includes(period)) {
            return fail(res, 400, "BAD_REQUEST", `invalid period (expected one of ${STATS_PERIODS.join(", ")})`);
        }
        res.json(sessions.statsForPeriod(period));
    });
    // Flexible multidimensional counterpart to /stats. The legacy endpoint stays
    // deliberately fixed-shape; analytics supports arbitrary combinations of
    // user/project/time plus operational dimensions and exact range filters.
    router.get("/analytics", (req, res) => {
        try {
            const query = parseSessionAnalyticsQuery(req.query);
            res.json(analyticsForSessions(sessions.list(), query, sessionArtifactInventory()));
        }
        catch (error) {
            if (error instanceof SessionAnalyticsQueryError)
                return fail(res, 400, "BAD_REQUEST", error.message);
            throw error;
        }
    });
    // --- sessions ------------------------------------------------------------
    // JSON-only session workflow routes moved to dedicated machine transport module.
    attachSessionRoutes(router, sessionRouterDeps);
    attachFleetSessionFileRoutes(router, { fileAccessService, sessionFiles });
    router.get("/sessions/:id/transcript", async (req, res) => {
        if (!sessions.get(req.params.id))
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        try {
            const pagination = parseTranscriptPageRequest(req.query.limit, req.query.cursor);
            if (!pagination)
                return res.json({ events: sessions.getTranscript(req.params.id) });
            res.json(await sessions.getTranscriptPage(req.params.id, pagination));
        }
        catch (error) {
            if (error instanceof TranscriptPaginationError)
                return fail(res, 400, error.code, error.message);
            throw error;
        }
    });
    // --- control -------------------------------------------------------------
    router.post("/control/pause", (_req, res) => res.json(settings.update({ paused: true })));
    router.post("/control/resume", (_req, res) => res.json(settings.update({ paused: false })));
    // Force a fresh update check for the overseer's explicit "Check now" action.
    // Update operations are serialized and return bounded status/result envelopes;
    // registry failures never expose provider output.
    router.post("/control/check-update", async (_req, res) => {
        const result = await checkUpdate();
        res.status(result.status).json(result.body);
    });
    // Self-update this peon (git pull / reinstall + restart) — the fleet-facing
    // twin of the local POST /api/v1/control/update, so Overseer can update
    // a peon (or roll the whole fleet) remotely. Production installs refuse while a
    // session is running unless { force: true }, since their restart kills it. Source
    // checkouts update files without restarting the dev daemon and report that a
    // manual restart is required for the new daemon code to take effect.
    router.post("/control/update", async (req, res) => {
        const requestId = typeof req.headers["peon-request-id"] === "string" ? req.headers["peon-request-id"] : "";
        const result = await applyUpdate(requestId, req.body);
        res.status(result.status).json(result.body);
    });
    router.get("/control/update/:requestId", (req, res) => {
        const result = updateOperationStatus(req.params.requestId);
        res.status(result.status).json(result.body);
    });
    // --- live tail (SSE, no human-presence bookkeeping) ----------------------
    // Every committed transcript event reaches every subscriber, in order,
    // exactly once, with no gap at the replay/live boundary: listeners are
    // registered *before* the transcript snapshot is read below, and both that
    // registration and the snapshot read are synchronous (no `await` between
    // them) — sessions service always appends-to-disk-then-emits within one
    // synchronous call, so nothing can land in between and be missed by both,
    // or delivered by both. Each transcript event's `id:` is its immutable,
    // persisted event identity, so a client that reconnects with Last-Event-ID
    // (which EventSource does automatically) gets exactly what it missed, once.
    // The atomic subscribe-then-snapshot handoff above is what a first
    // connection (no Last-Event-ID yet) relies on instead.
    router.get("/sessions/:id/stream", (req, res) => {
        const id = req.params.id;
        if (!sessions.get(id))
            return fail(res, 404, "UNKNOWN_SESSION", "unknown session");
        let resumeEventId;
        try {
            const lastEventIdHeader = req.headers["last-event-id"];
            resumeEventId = parseTranscriptResumeEventId(typeof lastEventIdHeader === "string" ? lastEventIdHeader : req.query.afterEventId);
        }
        catch (error) {
            if (error instanceof TranscriptPaginationError)
                return fail(res, 400, error.code, error.message);
            throw error;
        }
        // Headers (and the connection) go out immediately — the client shouldn't
        // wait on the first event, or even on the replay snapshot below, to know
        // the stream is live.
        res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
        });
        res.flushHeaders();
        // A write can still land between the client's disconnect and this
        // route's own "close" cleanup below (that gap is inherent — cleanup is
        // itself async); swallow the resulting stream error here rather than
        // letting an unhandled 'error' bring down the process.
        res.on("error", () => { });
        let closed = false;
        const send = (event, data, eventId) => {
            if (closed)
                return;
            let frame = `event: ${event}\n`;
            if (eventId !== undefined)
                frame += `id: ${eventId}\n`;
            // A JSON.stringify result never contains a literal newline (string
            // values are escaped), but split defensively anyway — a multiline
            // payload must become multiple `data:` lines, never a broken frame.
            for (const line of JSON.stringify(data).split("\n"))
                frame += `data: ${line}\n`;
            // A late write to an already-torn-down connection must never throw out
            // of this callback — sessions service calls emitter.emit() synchronously
            // from its own append path, so an uncaught throw here would stop every
            // *other* subscriber of the same event from being delivered to, too.
            try {
                res.write(`${frame}\n`);
            }
            catch {
                closed = true;
            }
        };
        const onEvent = (payload) => {
            if (payload.sessionId === id)
                send("event", payload.event, payload.eventId);
        };
        const onChange = (record) => {
            if (record.id === id)
                send("change", toPublicSessionRecord(record));
        };
        sessions.on("event", onEvent);
        sessions.on("change", onChange);
        // Snapshot after subscribing (see comment above). Last-Event-ID (sent
        // automatically by EventSource on reconnect) resumes from the client's
        // own cursor; absent, a fresh connection gets the full history.
        const transcript = sessions.getTranscriptEntries(id);
        const startAt = transcriptResumeIndex(transcript, resumeEventId);
        for (let i = startAt; i < transcript.length; i++)
            send("event", transcript[i].event, transcript[i].id);
        // Detects half-open connections through proxies/load balancers that
        // silently drop idle streams. Overridable so tests don't need to wait out
        // the real 15s+ interval to see one.
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
        req.on("close", () => {
            closed = true;
            clearInterval(heartbeat);
            sessions.off("event", onEvent);
            sessions.off("change", onChange);
        });
    });
    // --- file transfer -------------------------------------------------------
    // Disabled unless fileTransferRoot is set; every path is sandboxed to it.
    function fileTarget(req, res) {
        const root = settings.get().fileTransferRoot;
        if (!root) {
            fail(res, 503, "FILES_DISABLED", "file transfer is disabled — set fileTransferRoot to enable it");
            return null;
        }
        const segments = req.params.rest ?? [];
        const abs = resolveInRoot(root, segments);
        if (!abs) {
            fail(res, 400, "PATH_ESCAPE", "path escapes the file transfer root");
            return null;
        }
        return abs;
    }
    // Upload: stream the raw body to a temp file, hashing as it lands, then commit
    // with an atomic rename. If the client sent Peon-Content-Sha256 and it doesn't
    // match what arrived, the temp file is discarded and nothing is committed.
    router.put("/files/{*rest}", (req, res) => {
        const abs = fileTarget(req, res);
        if (!abs)
            return;
        const claimed = typeof req.headers["peon-content-sha256"] === "string" ? String(req.headers["peon-content-sha256"]).toLowerCase() : null;
        mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.tmp-${randomUUID()}`;
        const hash = createHash("sha256");
        let bytes = 0;
        const out = createWriteStream(tmp);
        const abort = (status, code, message) => {
            out.destroy();
            try {
                if (existsSync(tmp))
                    unlinkSync(tmp);
            }
            catch {
                /* best-effort cleanup */
            }
            if (!res.headersSent)
                fail(res, status, code, message);
        };
        req.on("data", (chunk) => {
            bytes += chunk.length;
            hash.update(chunk);
        });
        req.on("error", (err) => abort(400, "BAD_REQUEST", err.message));
        out.on("error", (err) => abort(500, "INTERNAL", err.message));
        req.pipe(out);
        out.on("finish", () => {
            const sha256 = hash.digest("hex");
            if (claimed && claimed !== sha256) {
                return abort(409, "CHECKSUM_MISMATCH", `body sha256 ${sha256} does not match Peon-Content-Sha256 ${claimed}`);
            }
            try {
                renameSync(tmp, abs);
            }
            catch (err) {
                return abort(500, "INTERNAL", err instanceof Error ? err.message : String(err));
            }
            res.status(201).json({ path: segmentsPath(req), size: bytes, sha256 });
        });
    });
    // Download, or ?stat=1 for metadata (size/mtime/sha256, or a directory
    // listing). Downloads support Range for resumable/partial reads.
    router.get("/files/{*rest}", async (req, res) => {
        const abs = fileTarget(req, res);
        if (!abs)
            return;
        let stat;
        try {
            stat = statSync(abs);
        }
        catch {
            return fail(res, 404, "NOT_FOUND", "no such file");
        }
        if (req.query.stat !== undefined) {
            if (stat.isDirectory()) {
                return res.json({
                    path: segmentsPath(req),
                    type: "directory",
                    entries: readdirSync(abs, { withFileTypes: true }).map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" })),
                });
            }
            return res.json({ path: segmentsPath(req), type: "file", size: stat.size, mtimeMs: stat.mtimeMs, sha256: await hashFile(abs) });
        }
        if (stat.isDirectory())
            return fail(res, 400, "IS_DIRECTORY", "path is a directory — use ?stat=1 to list it");
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Accept-Ranges", "bytes");
        const range = typeof req.headers.range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range) : null;
        if (range) {
            const size = stat.size;
            let start = range[1] ? parseInt(range[1], 10) : NaN;
            let end = range[2] ? parseInt(range[2], 10) : NaN;
            if (Number.isNaN(start)) {
                // suffix range: bytes=-N → last N bytes
                start = Math.max(0, size - (Number.isNaN(end) ? 0 : end));
                end = size - 1;
            }
            else if (Number.isNaN(end)) {
                end = size - 1;
            }
            if (start > end || start < 0 || end >= size) {
                res.setHeader("Content-Range", `bytes */${size}`);
                return fail(res, 416, "RANGE_NOT_SATISFIABLE", "requested range not satisfiable");
            }
            res.status(206);
            res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
            res.setHeader("Content-Length", String(end - start + 1));
            return void createReadStream(abs, { start, end }).on("error", () => res.destroy()).pipe(res);
        }
        res.setHeader("Content-Length", String(stat.size));
        createReadStream(abs).on("error", () => res.destroy()).pipe(res);
    });
    // Express decodes wildcard parameters before invoking a route. Convert a
    // malformed percent-encoded path into the same stable JSON contract as path
    // validation performed inside the project upload handler.
    router.use((err, _req, res, next) => {
        if (err instanceof URIError)
            return fail(res, 400, "INVALID_PATH", "upload path contains a malformed segment");
        next(err);
    });
    return router;
}
// The requested path as a single "a/b/c.txt" string, for echoing back in
// responses — Express hands us the segments pre-split.
function segmentsPath(req) {
    return (req.params.rest ?? []).join("/");
}
