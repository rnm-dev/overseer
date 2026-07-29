import semver from "semver";
import { armoryCatalogSchema, catalogCacheStateSchema, DEFAULT_ARMORY_REGISTRY_URL, MAX_CATALOG_BYTES, } from "./contracts.js";
import { AtomicJsonStore, ArmoryStorageError } from "./atomicJsonStore.js";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const OFFICIAL_CATALOG_HOST = "raw.githubusercontent.com";
const OFFICIAL_DOCUMENTATION_HOST = "github.com";
const OFFICIAL_RELEASE_HOST = "github.com";
const OFFICIAL_ICON_HOST = "raw.githubusercontent.com";
const RELEASE_PATH_PREFIX = "/rnm-dev/armory/releases/download/";
const DOCUMENTATION_PATH_PREFIX = "/rnm-dev/armory/";
export class ArmoryCatalogError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.code = code;
        this.name = "ArmoryCatalogError";
    }
}
const emptyCache = () => ({ schemaVersion: 1, registryUrl: null, catalog: null, etag: null, fetchedAt: null });
export class ArmoryCatalogClient {
    registryUrl;
    officialRegistry;
    cache;
    fetchImpl;
    timeoutMs;
    maxBytes;
    maxRedirects;
    allowedRegistryHosts;
    now;
    constructor(options) {
        this.registryUrl = normalizeRegistryUrl(process.env.PEON_ARMORY_REGISTRY_URL || options.registryUrl || DEFAULT_ARMORY_REGISTRY_URL);
        this.officialRegistry = this.registryUrl === DEFAULT_ARMORY_REGISTRY_URL;
        this.cache = new AtomicJsonStore({ filePath: options.cacheFile, schema: catalogCacheStateSchema, defaults: emptyCache });
        this.fetchImpl = options.fetchImpl ?? fetch;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxBytes = options.maxBytes ?? MAX_CATALOG_BYTES;
        this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
        const initialHost = new URL(this.registryUrl).hostname;
        this.allowedRegistryHosts = new Set(options.allowedRegistryHosts ?? [initialHost]);
        if (this.officialRegistry)
            this.allowedRegistryHosts.add(OFFICIAL_CATALOG_HOST);
        this.now = options.now ?? Date.now;
    }
    async cached() {
        const state = await this.readMatchingCache();
        if (!state?.catalog || state.fetchedAt === null)
            return null;
        return this.resultFromCache(state, null);
    }
    async refresh(options = {}) {
        let cache = null;
        let cacheReadError = null;
        try {
            cache = await this.readMatchingCache();
        }
        catch (error) {
            cacheReadError = safeRefreshError(error);
        }
        try {
            const response = await this.fetchCatalog(cache?.etag ?? null, options.force === true);
            if (response.status === 304) {
                if (!cache?.catalog || cache.fetchedAt === null)
                    throw new ArmoryCatalogError("INVALID_CATALOG", "Registry returned 304 without a usable cached catalog");
                return this.resultFromCache(cache, cacheReadError);
            }
            if (response.status !== 200)
                throw new ArmoryCatalogError("REGISTRY_UNAVAILABLE", `Registry returned HTTP ${response.status}`);
            const catalog = await parseBoundedCatalog(response, this.maxBytes);
            enforceCatalogPolicy(catalog);
            const state = {
                schemaVersion: 1,
                registryUrl: this.registryUrl,
                catalog,
                etag: response.headers.get("etag"),
                fetchedAt: this.now(),
            };
            await this.cache.write(state);
            return {
                catalog,
                source: "live",
                registryUrl: this.registryUrl,
                officialRegistry: this.officialRegistry,
                fetchedAt: state.fetchedAt,
                etag: state.etag,
                lastRefreshError: null,
            };
        }
        catch (error) {
            const safe = safeRefreshError(error);
            if (cache?.catalog && cache.fetchedAt !== null)
                return this.resultFromCache(cache, safe);
            if (error instanceof ArmoryCatalogError)
                throw error;
            throw new ArmoryCatalogError("REGISTRY_UNAVAILABLE", "Armory registry is unavailable and no cached catalog exists", { cause: error });
        }
    }
    async readMatchingCache() {
        const state = await this.cache.read();
        if (!state.catalog || state.registryUrl !== this.registryUrl)
            return null;
        enforceCatalogPolicy(state.catalog);
        return state;
    }
    resultFromCache(state, error) {
        return {
            catalog: state.catalog,
            source: "cached",
            registryUrl: this.registryUrl,
            officialRegistry: this.officialRegistry,
            fetchedAt: state.fetchedAt,
            etag: state.etag,
            lastRefreshError: error,
        };
    }
    async fetchCatalog(etag, force) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let current = new URL(this.registryUrl);
        if (force)
            current.searchParams.set("_peon_refresh", String(this.now()));
        try {
            for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
                this.validateRegistryRequest(current);
                let response;
                try {
                    response = await this.fetchImpl(current, {
                        headers: !force && etag ? { "If-None-Match": etag } : undefined,
                        redirect: "manual",
                        signal: controller.signal,
                    });
                }
                catch (error) {
                    if (controller.signal.aborted)
                        throw new ArmoryCatalogError("REGISTRY_TIMEOUT", "Armory registry request timed out", { cause: error });
                    throw new ArmoryCatalogError("REGISTRY_UNAVAILABLE", "Armory registry request failed", { cause: error });
                }
                if (![301, 302, 303, 307, 308].includes(response.status))
                    return response;
                if (redirects === this.maxRedirects)
                    throw new ArmoryCatalogError("REGISTRY_REDIRECT_INVALID", "Armory registry exceeded its redirect limit");
                const location = response.headers.get("location");
                if (!location)
                    throw new ArmoryCatalogError("REGISTRY_REDIRECT_INVALID", "Armory registry redirect omitted its destination");
                current = new URL(location, current);
            }
            throw new ArmoryCatalogError("REGISTRY_REDIRECT_INVALID", "Armory registry exceeded its redirect limit");
        }
        finally {
            clearTimeout(timer);
        }
    }
    validateRegistryRequest(url) {
        if (url.protocol !== "https:" || url.username || url.password || url.port)
            throw new ArmoryCatalogError("POLICY_DENIED", "Armory registry URL violates the HTTPS origin policy");
        if (!this.allowedRegistryHosts.has(url.hostname))
            throw new ArmoryCatalogError("POLICY_DENIED", "Armory registry redirect host is not approved");
        if (this.officialRegistry) {
            const canonical = new URL(url);
            canonical.searchParams.delete("_peon_refresh");
            const refreshValues = url.searchParams.getAll("_peon_refresh");
            const onlyRefreshParam = [...url.searchParams.keys()].every((key) => key === "_peon_refresh");
            if (canonical.href !== DEFAULT_ARMORY_REGISTRY_URL || !onlyRefreshParam || refreshValues.length > 1) {
                throw new ArmoryCatalogError("POLICY_DENIED", "Official Armory registry URL changed unexpectedly");
            }
        }
    }
}
function normalizeRegistryUrl(value) {
    let url;
    try {
        url = new URL(value);
    }
    catch (error) {
        throw new ArmoryCatalogError("POLICY_DENIED", "Armory registry URL is invalid", { cause: error });
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash)
        throw new ArmoryCatalogError("POLICY_DENIED", "Armory registry URL must be credential-free HTTPS with the default port");
    return url.href;
}
async function parseBoundedCatalog(response, maxBytes) {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
        const declared = Number(contentLength);
        if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes)
            throw new ArmoryCatalogError("CATALOG_TOO_LARGE", "Armory catalog exceeds the response size limit");
    }
    const chunks = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (reader) {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            bytes += value.byteLength;
            if (bytes > maxBytes) {
                await reader.cancel().catch(() => undefined);
                throw new ArmoryCatalogError("CATALOG_TOO_LARGE", "Armory catalog exceeds the streaming size limit");
            }
            chunks.push(value);
        }
    }
    const combined = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
    }
    catch (error) {
        throw new ArmoryCatalogError("INVALID_CATALOG", "Armory registry returned malformed JSON", { cause: error });
    }
    const result = armoryCatalogSchema.safeParse(parsed);
    if (!result.success)
        throw new ArmoryCatalogError("INVALID_CATALOG", `Armory catalog failed validation: ${result.error.issues[0]?.message ?? "unknown validation error"}`);
    return result.data;
}
function enforceCatalogPolicy(catalog) {
    for (const entry of catalog.packages) {
        validatePolicyUrl(entry.documentationUrl, OFFICIAL_DOCUMENTATION_HOST, DOCUMENTATION_PATH_PREFIX, "documentation");
        if (entry.iconUrl)
            validateIconUrl(entry.iconUrl, entry.id);
        for (const version of entry.versions)
            validatePolicyUrl(version.archive.url, OFFICIAL_RELEASE_HOST, RELEASE_PATH_PREFIX, "release archive");
        if (semver.prerelease(entry.latest))
            throw new ArmoryCatalogError("INVALID_CATALOG", `Package ${entry.id} uses a prerelease as latest`);
    }
}
function validateIconUrl(value, packageId) {
    const url = new URL(value);
    const prefix = `/rnm-dev/armory/main/packages/${packageId}/assets/`;
    if (url.protocol !== "https:" ||
        url.hostname !== OFFICIAL_ICON_HOST ||
        url.username ||
        url.password ||
        url.port ||
        !url.pathname.startsWith(prefix) ||
        !/\.(?:png|webp)$/i.test(url.pathname)) {
        throw new ArmoryCatalogError("POLICY_DENIED", `Armory catalog icon URL for ${packageId} is not an approved PNG/WebP asset path`);
    }
}
function validatePolicyUrl(value, host, prefix, label) {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password || url.port || !url.pathname.startsWith(prefix)) {
        throw new ArmoryCatalogError("POLICY_DENIED", `Armory catalog ${label} URL is not on an approved official GitHub path`);
    }
}
function safeRefreshError(error) {
    if (error instanceof ArmoryCatalogError)
        return { code: error.code, message: error.message };
    if (error instanceof ArmoryStorageError)
        return { code: "INVALID_CATALOG", message: "Armory catalog cache is invalid" };
    return { code: "REGISTRY_UNAVAILABLE", message: "Armory registry is unavailable" };
}
export function searchCatalog(catalog, query = "", options = {}) {
    const needle = query.trim().toLowerCase();
    const installed = new Set(options.installedIds ?? []);
    const filtered = catalog.packages.filter((entry) => {
        if (options.installedOnly && !installed.has(entry.id))
            return false;
        return !needle || `${entry.id} ${entry.displayName} ${entry.summary} ${entry.publisher}`.toLowerCase().includes(needle);
    });
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
    return { packages: filtered.slice(offset, offset + limit), total: filtered.length, nextOffset: offset + limit < filtered.length ? offset + limit : null };
}
export function getCatalogPackage(catalog, packageId) {
    const entry = catalog.packages.find((candidate) => candidate.id === packageId);
    if (!entry)
        throw new ArmoryCatalogError("PACKAGE_NOT_FOUND", `Armory package not found: ${packageId}`);
    return entry;
}
export function resolveCatalogVersion(catalog, packageId, options) {
    const entry = getCatalogPackage(catalog, packageId);
    const platform = options.platform ?? { os: process.platform, arch: process.arch };
    const requested = options.version ? entry.versions.find((candidate) => candidate.version === options.version) : null;
    if (options.version && !requested)
        throw new ArmoryCatalogError("VERSION_NOT_FOUND", `Armory package ${packageId} has no version ${options.version}`);
    const candidates = requested ? [requested] : entry.versions.filter((candidate) => semver.prerelease(candidate.version) === null).sort((a, b) => semver.rcompare(a.version, b.version));
    const platformMatches = candidates.filter((candidate) => candidate.platforms.some((supported) => supported.os === platform.os && supported.arch === platform.arch));
    if (platformMatches.length === 0)
        throw new ArmoryCatalogError("UNSUPPORTED_PLATFORM", `Armory package ${packageId} does not support ${platform.os}/${platform.arch}`);
    const compatible = platformMatches.find((candidate) => semver.gte(options.peonVersion, candidate.minPeonVersion));
    if (!compatible)
        throw new ArmoryCatalogError("INCOMPATIBLE_PEON_VERSION", `Armory package ${packageId} requires a newer Peon version`);
    return compatible;
}
export function detectCatalogUpdate(catalog, packageId, installedVersion, options) {
    const recommended = resolveCatalogVersion(catalog, packageId, options);
    return { updateAvailable: semver.gt(recommended.version, installedVersion), installedVersion, recommendedVersion: recommended.version };
}
