import { z } from "zod";
import semver from "semver";
export const ARMORY_SCHEMA_VERSION = 1;
export const DEFAULT_ARMORY_REGISTRY_URL = "https://raw.githubusercontent.com/rnm-dev/armory/main/armory.json";
export const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
export const MAX_ARCHIVE_DOWNLOAD_BYTES = 256 * 1024 * 1024;
export const MAX_ARCHIVE_EXPANDED_BYTES = 1024 * 1024 * 1024;
export const MAX_ARCHIVE_FILE_COUNT = 10_000;
export const MAX_HOOK_OUTPUT_BYTES = 1024 * 1024;
export const MAX_MCP_RESULT_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_STARTUP_MS = 15_000;
export const MAX_LIFECYCLE_MS = 120_000;
export const MAX_TOOL_CALL_MS = 60_000;
export const MAX_OPERATION_HISTORY = 100;
export const MAX_ARMORY_PROFILES = 100;
export const MAX_ARMORY_ASSIGNMENTS_PER_PROJECT = 100;
const packageId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);
const fieldId = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,127}$/);
const profileType = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const semanticVersion = z.string().refine((value) => semver.valid(value, { loose: false }) === value, "invalid semantic version");
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const relativePath = z.string().min(1).refine((value) => {
    if (value.startsWith("/") || value.includes("\\") || value.includes("\0") || value.includes("//"))
        return false;
    return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "must be a contained POSIX relative path");
export const armoryPlatformSchema = z.object({
    os: z.enum(["darwin", "linux"]),
    arch: z.enum(["x64", "arm64"]),
}).strict();
export const armoryArchiveSchema = z.object({
    url: z.url().refine((value) => value.startsWith("https://"), "must use HTTPS"),
    size: z.number().int().positive().max(MAX_ARCHIVE_DOWNLOAD_BYTES),
    sha256,
}).strict();
export const armoryInstallSelectionSchema = z.object({
    packageId,
    version: semanticVersion,
    minPeonVersion: semanticVersion,
    platforms: z.array(armoryPlatformSchema).min(1),
    capabilities: z.object({ mcp: z.boolean() }).strict().optional(),
    archive: armoryArchiveSchema,
}).strict();
const catalogVersionSchema = z.object({
    version: semanticVersion,
    minPeonVersion: semanticVersion,
    platforms: z.array(armoryPlatformSchema).min(1),
    archive: armoryArchiveSchema,
}).strict();
export const armoryCatalogPackageSchema = z.object({
    id: packageId,
    displayName: z.string().min(1).max(120),
    iconUrl: z.url().optional(),
    summary: z.string().min(1).max(500),
    publisher: z.literal("rnm-dev"),
    documentationUrl: z.url(),
    latest: semanticVersion,
    requirements: z.object({
        credentials: z.boolean(),
        hostWrites: z.boolean(),
    }).strict(),
    capabilities: z.object({ mcp: z.boolean() }).strict().default({ mcp: true }),
    versions: z.array(catalogVersionSchema).min(1),
}).strict();
export const armoryCatalogSchema = z.object({
    schemaVersion: z.literal(1),
    name: z.literal("rnm-dev/armory"),
    updatedAt: z.iso.datetime({ offset: true }),
    packages: z.array(armoryCatalogPackageSchema),
}).strict().superRefine((catalog, ctx) => {
    const packageIds = new Set();
    for (const [packageIndex, entry] of catalog.packages.entries()) {
        if (packageIds.has(entry.id))
            ctx.addIssue({ code: "custom", path: ["packages", packageIndex, "id"], message: "duplicate package id" });
        packageIds.add(entry.id);
        const versions = new Set();
        for (const [versionIndex, version] of entry.versions.entries()) {
            if (versions.has(version.version))
                ctx.addIssue({ code: "custom", path: ["packages", packageIndex, "versions", versionIndex, "version"], message: "duplicate version" });
            versions.add(version.version);
            const platforms = new Set();
            for (const [platformIndex, platform] of version.platforms.entries()) {
                const key = `${platform.os}/${platform.arch}`;
                if (platforms.has(key))
                    ctx.addIssue({ code: "custom", path: ["packages", packageIndex, "versions", versionIndex, "platforms", platformIndex], message: "duplicate platform" });
                platforms.add(key);
            }
        }
        if (!versions.has(entry.latest))
            ctx.addIssue({ code: "custom", path: ["packages", packageIndex, "latest"], message: "latest must reference a listed version" });
    }
});
const commandExecutable = z.string().refine((value) => value === "node" || relativePath.safeParse(value).success, "invalid command executable");
export const armoryCommandSchema = z.object({
    executable: commandExecutable,
    args: z.array(z.string().max(4096)).max(128),
}).strict();
const permissionSchema = z.object({
    networkHosts: z.array(z.string().regex(/^(?:\*|(?:\*\.)?[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/)),
    hostPaths: z.array(z.object({
        path: z.string().regex(/^(?:\/|~\/).+/),
        mode: z.enum(["read", "write"]),
        purpose: z.string().min(1).max(500),
    }).strict()),
}).strict();
const configurationFieldSchema = z.object({
    id: fieldId,
    label: z.string().min(1).max(120),
    help: z.string().max(1000).optional(),
    type: z.enum(["text", "secret", "select", "file"]),
    required: z.boolean(),
    options: z.array(z.object({ value: z.string().max(500), label: z.string().min(1).max(120) }).strict()).min(1).optional(),
    validation: z.object({ pattern: z.string().max(512).optional(), maxLength: z.number().int().positive().max(1024 * 1024).optional() }).strict().optional(),
}).strict().superRefine((field, ctx) => {
    if (field.type === "select" && !field.options)
        ctx.addIssue({ code: "custom", path: ["options"], message: "select fields require options" });
    if (field.type !== "select" && field.options)
        ctx.addIssue({ code: "custom", path: ["options"], message: "options are allowed only for select fields" });
    if (field.validation?.pattern) {
        try {
            new RegExp(field.validation.pattern);
        }
        catch {
            ctx.addIssue({ code: "custom", path: ["validation", "pattern"], message: "invalid regular expression" });
        }
    }
});
export const armoryManifestSchema = z.object({
    schemaVersion: z.literal(1),
    id: packageId,
    version: semanticVersion,
    minPeonVersion: semanticVersion,
    platforms: z.array(armoryPlatformSchema).min(1),
    permissions: permissionSchema,
    dependencies: z.tuple([]),
    configuration: z.object({
        fields: z.array(configurationFieldSchema).min(1),
        handler: armoryCommandSchema,
        verifyHandler: armoryCommandSchema.optional(),
        managedPaths: z.array(relativePath),
        environment: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), relativePath).optional(),
    }).strict().optional(),
    profile: z.object({
        type: profileType,
        requiredFields: z.array(fieldId).max(64).refine((fields) => new Set(fields).size === fields.length, "duplicate required field id"),
    }).strict().optional(),
    lifecycle: z.object({ postInstall: armoryCommandSchema.optional(), preUninstall: armoryCommandSchema.optional() }).strict().optional(),
    mcp: z.object({
        command: armoryCommandSchema,
        toolPrefix: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
        startupTimeoutMs: z.number().int().positive().max(MAX_MCP_STARTUP_MS).optional(),
        callTimeoutMs: z.number().int().positive().max(MAX_TOOL_CALL_MS).optional(),
    }).strict().optional(),
}).strict().superRefine((manifest, ctx) => {
    const platforms = new Set();
    for (const [index, platform] of manifest.platforms.entries()) {
        const key = `${platform.os}/${platform.arch}`;
        if (platforms.has(key))
            ctx.addIssue({ code: "custom", path: ["platforms", index], message: "duplicate platform" });
        platforms.add(key);
    }
    if (manifest.configuration) {
        const fields = new Set();
        for (const [index, field] of manifest.configuration.fields.entries()) {
            if (fields.has(field.id))
                ctx.addIssue({ code: "custom", path: ["configuration", "fields", index, "id"], message: "duplicate field id" });
            fields.add(field.id);
            if (field.options && new Set(field.options.map((option) => option.value)).size !== field.options.length)
                ctx.addIssue({ code: "custom", path: ["configuration", "fields", index, "options"], message: "duplicate select option value" });
        }
        if (new Set(manifest.configuration.managedPaths).size !== manifest.configuration.managedPaths.length)
            ctx.addIssue({ code: "custom", path: ["configuration", "managedPaths"], message: "duplicate managed path" });
        for (const name of Object.keys(manifest.configuration.environment ?? {})) {
            if (name === "PATH" || name.startsWith("PEON_ARMORY_"))
                ctx.addIssue({ code: "custom", path: ["configuration", "environment", name], message: "reserved environment variable" });
        }
    }
    if (manifest.profile) {
        if (!manifest.configuration) {
            ctx.addIssue({ code: "custom", path: ["profile"], message: "profile declarations require configuration fields" });
        }
        else {
            const fields = new Set(manifest.configuration.fields.map((field) => field.id));
            for (const [index, required] of manifest.profile.requiredFields.entries()) {
                if (!fields.has(required))
                    ctx.addIssue({ code: "custom", path: ["profile", "requiredFields", index], message: "required field is not declared in configuration fields" });
            }
        }
    }
});
export const installedArmoryPackageSchema = z.object({
    id: packageId,
    version: semanticVersion,
    enabled: z.boolean().optional(),
    state: z.enum(["installing", "needs_configuration", "verifying", "ready", "error", "removing"]),
    installedAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
    sourceDigest: sha256,
    configurationStatus: z.enum(["not_required", "missing", "unverified", "verified", "invalid"]).optional(),
    lastError: z.string().max(4000).nullable(),
    activeOperationId: z.string().uuid().nullable(),
    capabilities: z.object({ mcp: z.boolean() }).strict().optional(),
}).strict();
export const armoryOperationSchema = z.object({
    id: z.string().uuid(),
    packageId,
    kind: z.enum(["install", "update", "configure", "verify", "delete_configuration", "enable", "disable", "uninstall", "profile_configure", "profile_verify"]),
    status: z.enum(["queued", "running", "success", "failure", "needs_human"]),
    phase: z.string().min(1).max(120),
    progress: z.number().int().min(0).max(100).nullable(),
    message: z.string().max(1000),
    errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).nullable(),
    startedAt: z.number().int().nonnegative().nullable(),
    finishedAt: z.number().int().nonnegative().nullable(),
}).strict();
export const armoryActivationSchema = z.object({
    schemaVersion: z.literal(1),
    id: packageId,
    version: semanticVersion,
    previousVersion: semanticVersion.nullable(),
    activatedAt: z.number().int().nonnegative(),
    sourceDigest: sha256,
    operationId: z.string().uuid(),
    installed: installedArmoryPackageSchema,
}).strict().superRefine((activation, ctx) => {
    if (activation.installed.id !== activation.id)
        ctx.addIssue({ code: "custom", path: ["installed", "id"], message: "installed snapshot id must match activation" });
    if (activation.installed.version !== activation.version)
        ctx.addIssue({ code: "custom", path: ["installed", "version"], message: "installed snapshot version must match activation" });
    if (activation.installed.sourceDigest !== activation.sourceDigest)
        ctx.addIssue({ code: "custom", path: ["installed", "sourceDigest"], message: "installed snapshot digest must match activation" });
    if (activation.installed.activeOperationId !== null)
        ctx.addIssue({ code: "custom", path: ["installed", "activeOperationId"], message: "activated installed snapshot must be terminal" });
});
export const armoryCredentialMetadataSchema = z.object({
    packageId,
    configuredFields: z.record(fieldId, z.boolean()),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
}).strict();
export const armoryOwnershipEntrySchema = z.object({
    path: z.string().min(1),
    root: z.enum(["managed_home", "host"]),
    createdAt: z.number().int().nonnegative(),
}).strict();
const hookPackageSchema = z.object({ id: packageId, version: semanticVersion, dir: z.string().min(1), home: z.string().min(1) }).strict();
const hookBase = { protocolVersion: z.literal(1), type: z.literal("input"), package: hookPackageSchema, platform: armoryPlatformSchema };
const hookInputSchema = z.discriminatedUnion("operation", [
    z.object({ ...hookBase, operation: z.literal("post_install") }).strict(),
    z.object({ ...hookBase, operation: z.literal("configure"), configuration: z.record(fieldId, z.string().max(1024 * 1024)) }).strict(),
    z.object({ ...hookBase, operation: z.literal("verify") }).strict(),
    z.object({ ...hookBase, operation: z.literal("pre_uninstall") }).strict(),
]);
const hookProgressSchema = z.object({ protocolVersion: z.literal(1), type: z.literal("progress"), phase: z.string().min(1).max(120), message: z.string().max(1000), percent: z.number().int().min(0).max(100).nullable() }).strict();
const hookSuccessSchema = z.object({ protocolVersion: z.literal(1), type: z.literal("result"), ok: z.literal(true), message: z.string().max(1000), ownedPaths: z.array(z.string().min(1)).optional() }).strict().superRefine((result, ctx) => {
    if (result.ownedPaths && new Set(result.ownedPaths).size !== result.ownedPaths.length)
        ctx.addIssue({ code: "custom", path: ["ownedPaths"], message: "duplicate owned path" });
});
const hookFailureSchema = z.object({ protocolVersion: z.literal(1), type: z.literal("result"), ok: z.literal(false), message: z.string().max(1000), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/) }).strict();
export const armoryHookOutputSchema = z.union([hookProgressSchema, hookSuccessSchema, hookFailureSchema]);
export const armoryHookEventSchema = z.union([hookInputSchema, armoryHookOutputSchema]);
export const armorySettingsSchema = z.object({
    schemaVersion: z.literal(1).default(1),
    registryUrl: z.url().default(DEFAULT_ARMORY_REGISTRY_URL),
    agentInstallAllowlist: z.array(packageId).default([]),
}).strict();
export const installedStateSchema = z.object({ schemaVersion: z.literal(1).default(1), packages: z.record(packageId, installedArmoryPackageSchema).default({}) }).strict().superRefine((state, ctx) => {
    for (const [id, record] of Object.entries(state.packages))
        if (record.id !== id)
            ctx.addIssue({ code: "custom", path: ["packages", id, "id"], message: "record id must match package key" });
});
export const ownershipStateSchema = z.object({ schemaVersion: z.literal(1).default(1), packages: z.record(packageId, z.array(armoryOwnershipEntrySchema)).default({}) }).strict();
export const credentialStateSchema = z.object({
    schemaVersion: z.literal(1).default(1),
    packages: z.record(packageId, z.object({
        values: z.record(fieldId, z.string()),
        createdAt: z.number().int().nonnegative(),
        updatedAt: z.number().int().nonnegative(),
    }).strict()).default({}),
}).strict();
export const armoryProfileStatusSchema = z.enum(["missing", "unverified", "verified", "invalid"]);
export const armoryProfileRequirementSchema = z.object({
    type: profileType,
    requiredFields: z.array(fieldId).max(64).refine((fields) => new Set(fields).size === fields.length, "duplicate required field id"),
}).strict();
export const armoryProfileIdentitySchema = z.object({
    label: z.string().min(1).max(120),
    value: z.string().min(1).max(320),
}).strict();
export const armoryProfileSchema = z.object({
    profileId: z.string().uuid(),
    type: profileType,
    name: z.string().trim().min(1).max(80),
    status: armoryProfileStatusSchema,
    configuredFields: z.record(fieldId, z.literal(true)).refine((fields) => Object.keys(fields).length <= 64, "too many configured fields"),
    // The public identity the credential acts as, never secret material. See
    // profileIdentity.ts for what may be derived and why.
    identity: armoryProfileIdentitySchema.nullable(),
}).strict();
export const armoryAssignmentSchema = z.object({
    projectId: z.string().uuid(),
    packageId,
    profileId: z.string().uuid().nullable(),
}).strict();
const storedArmoryProfileSchema = z.object({
    profileId: z.string().uuid(),
    type: profileType,
    name: z.string().trim().min(1).max(80),
    status: armoryProfileStatusSchema,
    values: z.record(fieldId, z.string().max(1024 * 1024)).refine((values) => Object.keys(values).length <= 64, "too many profile fields"),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
}).strict();
export const armoryProjectPackagesStateSchema = z.object({
    schemaVersion: z.literal(1),
    migrationCompletedAt: z.number().int().nonnegative().nullable(),
    profiles: z.record(z.string().uuid(), storedArmoryProfileSchema),
    assignments: z.array(armoryAssignmentSchema).max(10_000),
    legacyProfileByPackage: z.record(packageId, z.string().uuid()),
}).strict().superRefine((state, ctx) => {
    for (const [profileId, profile] of Object.entries(state.profiles)) {
        if (profile.profileId !== profileId)
            ctx.addIssue({ code: "custom", path: ["profiles", profileId, "profileId"], message: "profile id must match profile key" });
    }
    const assignments = new Set();
    const perProject = new Map();
    for (const [index, assignment] of state.assignments.entries()) {
        const key = `${assignment.projectId}\0${assignment.packageId}`;
        if (assignments.has(key))
            ctx.addIssue({ code: "custom", path: ["assignments", index], message: "duplicate project package assignment" });
        assignments.add(key);
        const count = (perProject.get(assignment.projectId) ?? 0) + 1;
        perProject.set(assignment.projectId, count);
        if (count > MAX_ARMORY_ASSIGNMENTS_PER_PROJECT)
            ctx.addIssue({ code: "custom", path: ["assignments", index], message: "too many project assignments" });
        if (assignment.profileId !== null && !state.profiles[assignment.profileId])
            ctx.addIssue({ code: "custom", path: ["assignments", index, "profileId"], message: "assignment references an unknown profile" });
    }
    if (Object.keys(state.profiles).length > MAX_ARMORY_PROFILES)
        ctx.addIssue({ code: "custom", path: ["profiles"], message: "too many profiles" });
    for (const [legacyPackageId, profileId] of Object.entries(state.legacyProfileByPackage)) {
        if (!state.profiles[profileId])
            ctx.addIssue({ code: "custom", path: ["legacyProfileByPackage", legacyPackageId], message: "legacy alias references an unknown profile" });
    }
});
export const catalogCacheStateSchema = z.object({
    schemaVersion: z.literal(1),
    registryUrl: z.url().nullable(),
    catalog: armoryCatalogSchema.nullable(),
    etag: z.string().max(1024).nullable(),
    fetchedAt: z.number().int().nonnegative().nullable(),
}).strict().superRefine((state, ctx) => {
    const populated = state.registryUrl !== null || state.catalog !== null || state.fetchedAt !== null;
    if (populated && (state.registryUrl === null || state.catalog === null || state.fetchedAt === null)) {
        ctx.addIssue({ code: "custom", message: "catalog cache metadata must be populated together" });
    }
});
export function parseArmoryCatalog(value) { return armoryCatalogSchema.parse(value); }
export function parseArmoryManifest(value) { return armoryManifestSchema.parse(value); }
export function parseArmoryHookEvent(value) { return armoryHookEventSchema.parse(value); }
