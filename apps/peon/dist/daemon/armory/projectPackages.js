import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { armoryProjectPackagesStateSchema, MAX_ARMORY_ASSIGNMENTS_PER_PROJECT, MAX_ARMORY_PROFILES, parseArmoryManifest, } from "./contracts.js";
import { getArmoryActivation, retireLegacyArmoryActivationState } from "./installer.js";
import { ArmoryOperationCoordinator, ArmoryOperationError, withArmoryPackageLock } from "./operationCoordinator.js";
import { assertPackageId, packageVersionPath, resolveContainedPath } from "./paths.js";
export const ARMORY_PROJECT_PACKAGES_CAPABILITY = "armory-project-packages-v1";
export class ArmoryProjectPackagesError extends ArmoryOperationError {
    status;
    constructor(status, code, message, options) {
        super(code, message, options);
        this.status = status;
        this.name = "ArmoryProjectPackagesError";
    }
}
function safeProfile(profile) {
    return {
        profileId: profile.profileId,
        type: profile.type,
        name: profile.name,
        status: profile.status,
        configuredFields: Object.fromEntries(Object.keys(profile.values).sort().map((field) => [field, true])),
    };
}
function profileLockId(profileId) {
    return `profile-${profileId.replaceAll("-", "")}`;
}
export class ArmoryProjectPackagesService {
    options;
    operations;
    now;
    resolveManifest;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
        this.resolveManifest = options.manifestResolver ?? ((packageId) => loadInstalledManifest(options.stores, packageId));
        this.operations = new ArmoryOperationCoordinator(options.stores.operations, this.now);
    }
    async initializeMigration() {
        const current = await this.options.stores.projectPackages.read();
        const credentials = await this.options.stores.credentials.snapshot();
        if (current.migrationCompletedAt !== null && Object.keys(credentials.packages).length === 0) {
            await this.finishLegacyCleanup();
            return;
        }
        const installed = await this.options.stores.installed.list();
        if ((await this.options.stores.operations.list()).some((operation) => operation.status === "queued" || operation.status === "running")) {
            throw new ArmoryProjectPackagesError(409, "OPERATION_IN_PROGRESS", "Armory migration requires all package operations to be idle");
        }
        const manifests = new Map();
        for (const record of installed)
            manifests.set(record.id, (await this.resolveManifest(record.id)).manifest);
        const profiles = structuredClone(current.profiles);
        const legacyProfileByPackage = { ...current.legacyProfileByPackage };
        const assignments = [...current.assignments];
        const projects = this.options.projects.list();
        for (const [packageId, credential] of Object.entries(credentials.packages).sort(([left], [right]) => left.localeCompare(right))) {
            const manifest = manifests.get(packageId);
            if (!manifest) {
                throw new ArmoryProjectPackagesError(409, "ARMORY_MIGRATION_BLOCKED", `Legacy configuration belongs to an uninstalled package: ${packageId}`);
            }
            if (!manifest.profile) {
                throw new ArmoryProjectPackagesError(409, "ARMORY_MIGRATION_BLOCKED", `Legacy configuration cannot be represented by the installed package: ${packageId}`);
            }
            const installedRecord = installed.find((record) => record.id === packageId);
            const existingProfileId = legacyProfileByPackage[packageId];
            const profileId = existingProfileId ?? randomUUID();
            const existingProfile = existingProfileId ? profiles[existingProfileId] : undefined;
            if (existingProfile && existingProfile.type !== manifest.profile.type) {
                throw new ArmoryProjectPackagesError(409, "ARMORY_MIGRATION_BLOCKED", `Migrated profile type no longer matches the installed package: ${packageId}`);
            }
            profiles[profileId] = existingProfile && existingProfile.updatedAt > credential.updatedAt ? existingProfile : {
                profileId,
                type: manifest.profile.type,
                name: existingProfile?.name ?? packageId,
                status: legacyProfileStatus(installedRecord.configurationStatus, credential.values),
                values: structuredClone(credential.values),
                createdAt: existingProfile?.createdAt ?? credential.createdAt,
                updatedAt: credential.updatedAt,
            };
            legacyProfileByPackage[packageId] = profileId;
            if (current.migrationCompletedAt !== null || installedRecord.enabled === true) {
                for (const project of projects) {
                    if (!assignments.some((assignment) => assignment.projectId === project.projectId && assignment.packageId === packageId)) {
                        assignments.push({ projectId: project.projectId, packageId, profileId });
                    }
                }
            }
        }
        if (current.migrationCompletedAt === null) {
            for (const record of installed.filter((entry) => entry.enabled === true)) {
                const manifest = manifests.get(record.id);
                const profileId = manifest.profile ? legacyProfileByPackage[record.id] : null;
                if (manifest.profile && !profileId) {
                    throw new ArmoryProjectPackagesError(409, "ARMORY_MIGRATION_BLOCKED", `Enabled package has no compatible legacy configuration: ${record.id}`);
                }
                for (const project of projects) {
                    if (!assignments.some((assignment) => assignment.projectId === project.projectId && assignment.packageId === record.id)) {
                        assignments.push({ projectId: project.projectId, packageId: record.id, profileId });
                    }
                }
            }
        }
        const migrated = armoryProjectPackagesStateSchema.parse({
            schemaVersion: 1,
            migrationCompletedAt: current.migrationCompletedAt ?? this.now(),
            profiles,
            assignments,
            legacyProfileByPackage,
        });
        await this.options.stores.projectPackages.write(migrated);
        await this.finishLegacyCleanup();
    }
    async listProfiles() {
        const state = await this.readyState();
        return { profiles: Object.values(state.profiles).map(safeProfile).sort((left, right) => left.name.localeCompare(right.name) || left.profileId.localeCompare(right.profileId)) };
    }
    async getProfile(profileId) {
        return safeProfile(await this.requireProfile(await this.readyState(), profileId));
    }
    async createProfile(type, name) {
        await this.initializeMigration();
        const profileId = randomUUID();
        let created;
        await this.options.stores.projectPackages.update((state) => {
            if (Object.keys(state.profiles).length >= MAX_ARMORY_PROFILES)
                throw new ArmoryProjectPackagesError(409, "PROFILE_LIMIT_REACHED", `A Peon may store at most ${MAX_ARMORY_PROFILES} profiles`);
            created = { profileId, type, name: name.trim(), status: "missing", values: {}, createdAt: this.now(), updatedAt: this.now() };
            return armoryProjectPackagesStateSchema.parse({ ...state, profiles: { ...state.profiles, [profileId]: created } });
        });
        return safeProfile(created);
    }
    async renameProfile(profileId, name) {
        await this.initializeMigration();
        return withArmoryPackageLock(this.options.stores.operations.directory, profileLockId(profileId), randomUUID(), async () => {
            let updated;
            await this.options.stores.projectPackages.update((state) => {
                const current = this.requireProfile(state, profileId);
                updated = { ...current, name: name.trim(), updatedAt: this.now() };
                return armoryProjectPackagesStateSchema.parse({ ...state, profiles: { ...state.profiles, [profileId]: updated } });
            });
            return safeProfile(updated);
        });
    }
    async deleteProfile(profileId) {
        await this.initializeMigration();
        return withArmoryPackageLock(this.options.stores.operations.directory, profileLockId(profileId), randomUUID(), async () => {
            let deleted;
            await this.options.stores.projectPackages.update((state) => {
                deleted = this.requireProfile(state, profileId);
                if (state.assignments.some((assignment) => assignment.profileId === profileId)) {
                    throw new ArmoryProjectPackagesError(409, "PROFILE_IN_USE", "Profile is referenced by a project package assignment");
                }
                const profiles = { ...state.profiles };
                delete profiles[profileId];
                const legacyProfileByPackage = Object.fromEntries(Object.entries(state.legacyProfileByPackage).filter(([, id]) => id !== profileId));
                return armoryProjectPackagesStateSchema.parse({ ...state, profiles, legacyProfileByPackage });
            });
            return safeProfile(deleted);
        });
    }
    async configureProfile(profileId, values) {
        await this.initializeMigration();
        await this.getProfile(profileId);
        return this.operations.start(profileLockId(profileId), "profile_configure", async () => {
            await this.options.stores.projectPackages.update((state) => {
                const current = this.requireProfile(state, profileId);
                const updated = {
                    ...current,
                    values: structuredClone(values),
                    status: Object.keys(values).length === 0 ? "missing" : "unverified",
                    updatedAt: this.now(),
                };
                return armoryProjectPackagesStateSchema.parse({ ...state, profiles: { ...state.profiles, [profileId]: updated } });
            });
        });
    }
    async clearProfileConfiguration(profileId) {
        return this.configureProfile(profileId, {});
    }
    async verifyProfile(profileId) {
        await this.initializeMigration();
        await this.getProfile(profileId);
        return this.operations.start(profileLockId(profileId), "profile_verify", async () => {
            const state = await this.options.stores.projectPackages.read();
            const profile = this.requireProfile(state, profileId);
            try {
                const manifests = await this.manifestsForType(profile.type);
                validateProfileValues(profile, manifests);
                await this.setProfileStatus(profileId, "verified");
            }
            catch (error) {
                await this.setProfileStatus(profileId, "invalid").catch(() => undefined);
                throw error;
            }
        });
    }
    async listAssignments(projectId) {
        this.requireProject(projectId);
        const state = await this.readyState();
        return { assignments: state.assignments.filter((assignment) => assignment.projectId === projectId).sort((left, right) => left.packageId.localeCompare(right.packageId)) };
    }
    async getAssignment(projectId, packageId) {
        this.requireProject(projectId);
        const id = assertPackageId(packageId);
        const assignment = (await this.readyState()).assignments.find((entry) => entry.projectId === projectId && entry.packageId === id);
        if (!assignment)
            throw new ArmoryProjectPackagesError(404, "ASSIGNMENT_NOT_FOUND", "Project package assignment was not found");
        return structuredClone(assignment);
    }
    async installedPackageView(packageId) {
        const { installed, manifest } = await this.resolveManifest(packageId);
        const state = installed.state === "needs_configuration" || installed.state === "verifying" ? "ready" : installed.state;
        return { packageId: installed.id, version: installed.version, state, profileRequirement: manifest.profile ?? null };
    }
    async setAssignment(projectId, packageId, profileId) {
        await this.initializeMigration();
        this.requireProject(projectId);
        const id = assertPackageId(packageId);
        return withArmoryPackageLock(this.options.stores.operations.directory, id, randomUUID(), async () => {
            const { installed, manifest } = await this.resolveManifest(id).catch((error) => {
                if (error instanceof ArmoryProjectPackagesError)
                    throw error;
                throw new ArmoryProjectPackagesError(404, "PACKAGE_NOT_INSTALLED", `Armory package is not installed: ${id}`, { cause: error });
            });
            if (installed.state !== "ready")
                throw new ArmoryProjectPackagesError(409, "PACKAGE_NOT_READY", `Armory package is not ready: ${id}`);
            if (!manifest.profile) {
                if (profileId !== null)
                    throw new ArmoryProjectPackagesError(409, "PROFILE_TYPE_MISMATCH", "Credential-free packages require profileId null");
            }
            const assignment = { projectId, packageId: id, profileId };
            await this.options.stores.projectPackages.update((latest) => {
                if (manifest.profile) {
                    if (profileId === null)
                        throw new ArmoryProjectPackagesError(409, "PROFILE_NOT_FOUND", "This package requires a profile");
                    const profile = this.requireProfile(latest, profileId);
                    if (profile.type !== manifest.profile.type)
                        throw new ArmoryProjectPackagesError(409, "PROFILE_TYPE_MISMATCH", "Profile type does not match the package declaration");
                    const missing = manifest.profile.requiredFields.filter((field) => !(field in profile.values) || profile.values[field]?.length === 0);
                    if (missing.length > 0)
                        throw new ArmoryProjectPackagesError(409, "PROFILE_FIELDS_MISSING", `Profile is missing required fields: ${missing.join(", ")}`);
                    if (profile.status !== "verified")
                        throw new ArmoryProjectPackagesError(409, "PROFILE_NOT_VERIFIED", "Profile must be verified before assignment");
                }
                const others = latest.assignments.filter((entry) => entry.projectId !== projectId || entry.packageId !== id);
                if (!latest.assignments.some((entry) => entry.projectId === projectId && entry.packageId === id)
                    && others.filter((entry) => entry.projectId === projectId).length >= MAX_ARMORY_ASSIGNMENTS_PER_PROJECT) {
                    throw new ArmoryProjectPackagesError(409, "ASSIGNMENT_LIMIT_REACHED", `A project may have at most ${MAX_ARMORY_ASSIGNMENTS_PER_PROJECT} Armory assignments`);
                }
                return armoryProjectPackagesStateSchema.parse({ ...latest, assignments: [...others, assignment] });
            });
            return assignment;
        });
    }
    async removeAssignment(projectId, packageId) {
        await this.initializeMigration();
        this.requireProject(projectId);
        const id = assertPackageId(packageId);
        return withArmoryPackageLock(this.options.stores.operations.directory, id, randomUUID(), async () => {
            let removed;
            await this.options.stores.projectPackages.update((state) => {
                removed = state.assignments.find((entry) => entry.projectId === projectId && entry.packageId === id);
                if (!removed)
                    throw new ArmoryProjectPackagesError(404, "ASSIGNMENT_NOT_FOUND", "Project package assignment was not found");
                return armoryProjectPackagesStateSchema.parse({ ...state, assignments: state.assignments.filter((entry) => entry !== removed) });
            });
            return structuredClone(removed);
        });
    }
    async legacyConfigurationSchema(packageId) {
        const { manifest } = await this.resolveManifest(packageId);
        // The field contract belongs to the installed manifest, not to a profile.
        // A package installed after the migration, or one that was never
        // configured, has no legacy profile and must still be able to state which
        // fields a new profile needs.
        const profile = await this.legacyProfileOrNull(packageId);
        return {
            fields: manifest.configuration?.fields ?? [],
            configured: profile ? safeProfile(profile).configuredFields : {},
            hostWrites: manifest.permissions.hostPaths.filter((entry) => entry.mode === "write").map((entry) => entry.path),
        };
    }
    async configureLegacyPackageProfile(packageId, values) {
        return this.configureProfile((await this.legacyProfile(packageId)).profileId, values);
    }
    async verifyLegacyPackageProfile(packageId) {
        return this.verifyProfile((await this.legacyProfile(packageId)).profileId);
    }
    async clearLegacyPackageProfile(packageId) {
        return this.clearProfileConfiguration((await this.legacyProfile(packageId)).profileId);
    }
    async readyState() {
        await this.initializeMigration();
        return this.options.stores.projectPackages.read();
    }
    requireProfile(state, profileId) {
        const profile = state.profiles[profileId];
        if (!profile)
            throw new ArmoryProjectPackagesError(404, "PROFILE_NOT_FOUND", "Armory profile was not found");
        return structuredClone(profile);
    }
    requireProject(projectId) {
        if (!this.options.projects.list().some((project) => project.projectId === projectId)) {
            throw new ArmoryProjectPackagesError(404, "PROJECT_NOT_FOUND", "Project was not found");
        }
    }
    async setProfileStatus(profileId, status) {
        await this.options.stores.projectPackages.update((state) => {
            const current = this.requireProfile(state, profileId);
            return armoryProjectPackagesStateSchema.parse({
                ...state,
                profiles: { ...state.profiles, [profileId]: { ...current, status, updatedAt: this.now() } },
            });
        });
    }
    async manifestsForType(type) {
        const installed = await this.options.stores.installed.list();
        const manifests = [];
        for (const record of installed.sort((left, right) => left.id.localeCompare(right.id))) {
            const resolved = await this.resolveManifest(record.id);
            if (resolved.manifest.profile?.type === type)
                manifests.push(resolved.manifest);
        }
        if (manifests.length === 0)
            throw new ArmoryProjectPackagesError(404, "PACKAGE_NOT_INSTALLED", "No installed package accepts this profile type");
        return manifests;
    }
    async legacyProfile(packageId) {
        const profile = await this.legacyProfileOrNull(packageId);
        if (!profile)
            throw new ArmoryProjectPackagesError(404, "PROFILE_NOT_FOUND", "Package has no migrated legacy profile");
        return profile;
    }
    async legacyProfileOrNull(packageId) {
        const state = await this.readyState();
        const profileId = state.legacyProfileByPackage[assertPackageId(packageId)];
        if (!profileId)
            return null;
        return this.requireProfile(state, profileId);
    }
    async finishLegacyCleanup() {
        await this.options.stores.installed.retireLegacyActivationState();
        await retireLegacyArmoryActivationState(this.options.stores);
        await this.options.stores.credentials.clear();
    }
}
function legacyProfileStatus(status, values) {
    if (Object.keys(values).length === 0)
        return "missing";
    if (status === "verified")
        return "verified";
    if (status === "invalid")
        return "invalid";
    return "unverified";
}
function validateProfileValues(profile, manifests) {
    if (Object.keys(profile.values).length === 0)
        throw new ArmoryProjectPackagesError(409, "PROFILE_FIELDS_MISSING", "Profile has no configured fields");
    const required = new Set(manifests.flatMap((manifest) => manifest.profile?.requiredFields ?? []));
    const missing = [...required].filter((fieldId) => !Object.prototype.hasOwnProperty.call(profile.values, fieldId) || profile.values[fieldId]?.length === 0);
    if (missing.length > 0)
        throw new ArmoryProjectPackagesError(409, "PROFILE_FIELDS_MISSING", `Profile is missing required fields: ${missing.sort().join(", ")}`);
    const fields = new Map();
    for (const manifest of manifests) {
        for (const field of manifest.configuration?.fields ?? [])
            if (!fields.has(field.id))
                fields.set(field.id, field);
    }
    for (const [fieldId, value] of Object.entries(profile.values)) {
        const field = fields.get(fieldId);
        if (!field)
            throw new ArmoryProjectPackagesError(400, "CONFIGURATION_FIELD_UNKNOWN", `Unknown configuration field: ${fieldId}`);
        if (field.validation?.maxLength && value.length > field.validation.maxLength)
            throw new ArmoryProjectPackagesError(400, "CONFIGURATION_FIELD_INVALID", `Configuration field is too long: ${fieldId}`);
        if (field.validation?.pattern && !new RegExp(field.validation.pattern).test(value))
            throw new ArmoryProjectPackagesError(400, "CONFIGURATION_FIELD_INVALID", `Configuration field has an invalid value: ${fieldId}`);
        if (field.type === "select" && !field.options?.some((option) => option.value === value))
            throw new ArmoryProjectPackagesError(400, "CONFIGURATION_FIELD_INVALID", `Configuration field has an invalid selection: ${fieldId}`);
    }
}
export async function loadInstalledManifest(stores, packageId) {
    const id = assertPackageId(packageId);
    const [activation, installed] = await Promise.all([getArmoryActivation(stores, id), stores.installed.get(id)]);
    if (!activation || !installed)
        throw new ArmoryProjectPackagesError(404, "PACKAGE_NOT_INSTALLED", `Armory package is not installed: ${id}`);
    const packageDir = packageVersionPath(stores.paths, id, activation.version);
    try {
        const manifest = parseArmoryManifest(JSON.parse(await readFile(resolveContainedPath(packageDir, "armory.package.json"), "utf8")));
        return { installed, manifest };
    }
    catch (error) {
        throw new ArmoryProjectPackagesError(409, "PACKAGE_NOT_READY", `Installed package manifest is invalid: ${id}`, { cause: error });
    }
}
export async function removeProjectPackageAssignmentsForUninstall(stores, packageId) {
    const id = assertPackageId(packageId);
    const state = await stores.projectPackages.read();
    if (state.migrationCompletedAt === null || !state.assignments.some((assignment) => assignment.packageId === id))
        return;
    await stores.projectPackages.update((latest) => armoryProjectPackagesStateSchema.parse({
        ...latest,
        assignments: latest.assignments.filter((assignment) => assignment.packageId !== id),
    }));
}
