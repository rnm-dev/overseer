import express from "express";
import { z } from "zod";
import { ArmoryConfigurationService } from "./configuration.js";
import { armoryInstallSelectionSchema, armorySettingsSchema } from "./contracts.js";
import { ArmoryPackageInstallService } from "./installer.js";
import { ArmoryInventoryError, armoryInventory } from "./inventory.js";
import { ArmoryOperationError } from "./operationCoordinator.js";
import { ArmoryProjectPackagesError } from "./projectPackages.js";
import { createArmoryStores } from "./stores.js";
const installBodySchema = z.object({
    version: armoryInstallSelectionSchema.shape.version.optional(),
}).strict();
const uninstallBodySchema = z.object({
    purge: z.boolean().optional(),
}).strict();
const configurationBodySchema = z.object({
    values: z.record(z.string(), z.string().max(1024 * 1024)),
    confirmHostWrites: z.boolean().optional(),
}).strict();
const createProfileBodySchema = z.object({
    type: z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/),
    name: z.string().trim().min(1).max(80),
}).strict();
const renameProfileBodySchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const profileConfigurationBodySchema = z.object({
    values: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/), z.string().max(1024 * 1024)).refine((values) => Object.keys(values).length <= 64, "too many profile fields"),
}).strict();
const assignmentBodySchema = z.object({ profileId: z.string().uuid().nullable() }).strict();
const deleteConfigurationBodySchema = z.object({
    includeHost: z.boolean().optional(),
    confirmHostWrites: z.boolean().optional(),
}).strict();
const settingsPatchSchema = z.object({
    registryUrl: z.string().url().optional(),
    agentInstallAllowlist: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/)).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "at least one setting is required");
function singleQuery(value) {
    if (value === undefined)
        return undefined;
    if (typeof value === "string")
        return value;
    throw new ArmoryInventoryError("BAD_REQUEST", "query parameters must not be repeated");
}
function installedOnly(value) {
    if (value === undefined)
        return undefined;
    if (value === "1" || value === "true")
        return true;
    if (value === "0" || value === "false")
        return false;
    throw new ArmoryInventoryError("BAD_REQUEST", "installed must be true, false, 1, or 0");
}
function limit(value) {
    if (value === undefined)
        return undefined;
    if (typeof value !== "string" || !/^\d+$/.test(value)) {
        throw new ArmoryInventoryError("BAD_REQUEST", "limit must be an integer between 1 and 100");
    }
    return Number(value);
}
function safeSettings(settings) {
    const effectiveRegistryUrl = process.env.PEON_ARMORY_REGISTRY_URL || settings.registryUrl;
    return {
        registryUrl: settings.registryUrl,
        effectiveRegistryUrl,
        registryOverridden: effectiveRegistryUrl !== settings.registryUrl,
        agentInstallAllowlist: settings.agentInstallAllowlist,
    };
}
function validateRegistryUrl(value) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) {
        throw new ArmoryInventoryError("BAD_REQUEST", "registryUrl must be credential-free HTTPS with the default port");
    }
}
export function createArmoryReadRouter(inventory = armoryInventory, options = {}) {
    const router = express.Router();
    const stores = createArmoryStores();
    const settings = options.settings ?? stores.settings;
    const configuration = options.configuration ?? new ArmoryConfigurationService({ stores });
    const operations = options.operations ?? stores.operations;
    const installer = options.installer ?? new ArmoryPackageInstallService({ stores, inventory, runtime: options.runtime });
    const projectPackages = () => {
        if (!options.projectPackagesCapability || !options.projectPackages) {
            throw new ArmoryProjectPackagesError(409, "UNSUPPORTED_CAPABILITY", "Peon does not advertise armory-project-packages-v1");
        }
        return options.projectPackages;
    };
    const list = async (req, res) => {
        try {
            const result = await inventory.list({
                q: singleQuery(req.query.q),
                installedOnly: installedOnly(req.query.installed),
                limit: limit(req.query.limit),
                cursor: singleQuery(req.query.cursor),
            });
            res.json(options.projectPackagesCapability ? await safeCapableInventory(result, projectPackages()) : result);
        }
        catch (error) {
            sendError(res, error);
        }
    };
    router.get("/catalog", list);
    router.get("/packages", list);
    router.get("/settings", async (_req, res) => {
        try {
            res.json(safeSettings(await settings.read()));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get("/profiles", async (_req, res) => {
        try {
            res.json(await projectPackages().listProfiles());
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get("/projects/:projectId/assignments", async (req, res) => {
        try {
            res.json(await projectPackages().listAssignments(req.params.projectId));
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get("/packages/:id/configuration", async (req, res) => {
        try {
            const schema = options.projectPackagesCapability
                ? await projectPackages().legacyConfigurationSchema(req.params.id)
                : await configuration.schema(req.params.id);
            res.json({ packageId: req.params.id, ...schema });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get("/packages/:id", async (req, res) => {
        try {
            const result = await inventory.get(req.params.id);
            res.json(options.projectPackagesCapability ? await safeCapableInventory(result, projectPackages()) : result);
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get("/packages/:id/mcp", async (req, res) => {
        try {
            if (!options.mcp)
                throw new ArmoryInventoryError("NOT_FOUND", "Armory MCP runtime is unavailable");
            const detail = await options.mcp.describe(req.params.id);
            if (options.projectPackagesCapability && detail && typeof detail === "object") {
                const { enabled: _enabled, ...safe } = detail;
                res.json(safe);
            }
            else
                res.json(detail);
        }
        catch (error) {
            sendError(res, error);
        }
    });
    router.get("/operations/:id", async (req, res) => {
        try {
            const operation = await operations.get(req.params.id);
            if (!operation)
                throw new ArmoryInventoryError("NOT_FOUND", `Armory operation not found: ${req.params.id}`);
            res.json({ operation: operation.kind === "profile_configure" || operation.kind === "profile_verify" ? toProfileOperation(operation) : operation });
        }
        catch (error) {
            sendError(res, error);
        }
    });
    if (options.allowMutations) {
        router.post("/profiles", async (req, res) => {
            try {
                const body = createProfileBodySchema.parse(req.body);
                res.status(201).json(await projectPackages().createProfile(body.type, body.name));
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.patch("/profiles/:profileId", async (req, res) => {
            try {
                const body = renameProfileBodySchema.parse(req.body);
                res.json(await projectPackages().renameProfile(req.params.profileId, body.name));
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.delete("/profiles/:profileId", async (req, res) => {
            try {
                res.json(await projectPackages().deleteProfile(req.params.profileId));
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.put("/profiles/:profileId/configuration", async (req, res) => {
            try {
                const body = profileConfigurationBodySchema.parse(req.body);
                res.status(202).json(toProfileOperation(await projectPackages().configureProfile(req.params.profileId, body.values)));
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.post("/profiles/:profileId/verify", async (req, res) => {
            try {
                res.status(202).json(toProfileOperation(await projectPackages().verifyProfile(req.params.profileId)));
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.put("/projects/:projectId/assignments/:packageId", async (req, res) => {
            try {
                const body = assignmentBodySchema.parse(req.body);
                res.json(await projectPackages().setAssignment(req.params.projectId, req.params.packageId, body.profileId));
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.delete("/projects/:projectId/assignments/:packageId", async (req, res) => {
            try {
                res.json(await projectPackages().removeAssignment(req.params.projectId, req.params.packageId));
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.post("/refresh", async (_req, res) => {
            try {
                const result = await inventory.list({ limit: 100, forceRefresh: true });
                res.json(options.projectPackagesCapability ? await safeCapableInventory(result, projectPackages()) : result);
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.post("/packages/:id/install", async (req, res) => {
            try {
                const body = installBodySchema.parse(req.body ?? {});
                const operation = await installer.install(req.params.id, body);
                res.status(202).json({ operation });
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.post("/packages/:id/update", async (req, res) => {
            try {
                const body = installBodySchema.parse(req.body ?? {});
                const operation = await installer.update(req.params.id, body);
                res.status(202).json({ operation });
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.post("/packages/:id/enable", async (req, res) => {
            try {
                if (options.projectPackagesCapability)
                    throw new ArmoryProjectPackagesError(410, "ARMORY_ACTIVATION_RETIRED", "Package enablement is replaced by project assignments");
                if (!options.lifecycle)
                    throw new ArmoryOperationError("MCP_RUNTIME_UNAVAILABLE", "Armory MCP runtime is unavailable");
                const operation = await options.lifecycle.enable(req.params.id);
                res.status(202).json({ operation });
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.post("/packages/:id/disable", async (req, res) => {
            try {
                if (options.projectPackagesCapability)
                    throw new ArmoryProjectPackagesError(410, "ARMORY_ACTIVATION_RETIRED", "Package enablement is replaced by project assignments");
                if (!options.lifecycle)
                    throw new ArmoryOperationError("MCP_RUNTIME_UNAVAILABLE", "Armory MCP runtime is unavailable");
                const operation = await options.lifecycle.disable(req.params.id);
                res.status(202).json({ operation });
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.delete("/packages/:id", async (req, res) => {
            try {
                if (!options.uninstaller)
                    throw new ArmoryOperationError("UNINSTALL_UNAVAILABLE", "Armory uninstall is unavailable");
                const body = uninstallBodySchema.parse(req.body ?? {});
                if (body.purge)
                    throw new ArmoryOperationError("PURGE_NOT_SUPPORTED", "Armory purge is not implemented; ordinary uninstall preserves configuration");
                const operation = await options.uninstaller.uninstall(req.params.id);
                res.status(202).json({ operation });
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.patch("/settings", async (req, res) => {
            try {
                const patch = settingsPatchSchema.parse(req.body);
                if (patch.registryUrl)
                    validateRegistryUrl(patch.registryUrl);
                const updated = await settings.update((current) => armorySettingsSchema.parse({ ...current, ...patch }));
                res.json(safeSettings(updated));
            }
            catch (error) {
                sendError(res, error);
            }
        });
    }
    if (options.allowMutations) {
        router.post("/packages/:id/configuration/verify", async (req, res) => {
            try {
                const operation = options.projectPackagesCapability
                    ? await projectPackages().verifyLegacyPackageProfile(req.params.id)
                    : await configuration.verify(req.params.id);
                res.status(202).json({ operation });
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.put("/packages/:id/configuration", async (req, res) => {
            try {
                const body = configurationBodySchema.parse(req.body);
                const operation = options.projectPackagesCapability
                    ? await projectPackages().configureLegacyPackageProfile(req.params.id, body.values)
                    : await configuration.configure(req.params.id, body.values, { confirmHostWrites: body.confirmHostWrites });
                res.status(202).json({ operation });
            }
            catch (error) {
                sendError(res, error);
            }
        });
        router.delete("/packages/:id/configuration", async (req, res) => {
            try {
                const body = deleteConfigurationBodySchema.parse(req.body ?? {});
                const operation = options.projectPackagesCapability
                    ? await projectPackages().clearLegacyPackageProfile(req.params.id)
                    : await configuration.deleteConfiguration(req.params.id, body);
                res.status(202).json({ operation });
            }
            catch (error) {
                sendError(res, error);
            }
        });
    }
    return router;
}
function sendError(res, error) {
    if (error instanceof ArmoryProjectPackagesError) {
        res.status(error.status).json({ error: error.message.slice(0, 4000), code: error.code });
        return;
    }
    if (error instanceof ArmoryInventoryError) {
        res.status(error.code === "NOT_FOUND" ? 404 : 400).json({ error: error.message, code: error.code });
        return;
    }
    if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? "invalid request", code: "BAD_REQUEST" });
        return;
    }
    if (error instanceof ArmoryOperationError) {
        const status = error.code === "OPERATION_IN_PROGRESS" ? 409
            : error.code === "PACKAGE_ALREADY_INSTALLED" ? 409
                : error.code === "NO_UPDATE_AVAILABLE" ? 409
                    : error.code === "PACKAGE_NOT_AVAILABLE" || error.code === "PACKAGE_NOT_FOUND" ? 404
                        : error.code === "PACKAGE_NOT_ACTIVE" ? 404
                            : 400;
        res.status(status).json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) });
        return;
    }
    console.error("Armory API request failed:", error);
    res.status(500).json({ error: "Armory API request failed", code: "INTERNAL" });
}
function toProfileOperation(operation) {
    return {
        operationId: operation.id,
        kind: operation.kind,
        status: operation.status === "success" ? "succeeded" : operation.status === "failure" ? "failed" : operation.status,
        code: operation.errorCode,
    };
}
async function safeCapableInventory(view, service) {
    if (view.packages) {
        return {
            ...view,
            packages: await Promise.all(view.packages.map((entry) => safeCapablePackage(entry, service))),
        };
    }
    if (view.package) {
        return {
            ...view,
            package: await safeCapablePackage(view.package, service),
        };
    }
    return view;
}
async function safeCapablePackage(entry, service) {
    if (!entry.installed)
        return entry;
    try {
        return { ...entry, installed: await service.installedPackageView(entry.id) };
    }
    catch (error) {
        if (error instanceof ArmoryProjectPackagesError && error.code === "PACKAGE_NOT_INSTALLED") {
            console.warn(`ignored stale Armory installed projection for ${entry.id}`);
            return { ...entry, installed: null };
        }
        if (error instanceof ArmoryProjectPackagesError && error.code === "PACKAGE_NOT_READY") {
            const installed = entry.installed;
            if (typeof installed.version !== "string")
                throw error;
            console.warn(`isolated unreadable Armory package ${entry.id}: ${error.message}`);
            return {
                ...entry,
                installed: { packageId: entry.id, version: installed.version, state: "error", profileRequirement: null },
            };
        }
        throw error;
    }
}
