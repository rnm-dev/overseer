import semver from "semver";
export const PEON_NPM_PACKAGE = "@rnm-dev/peon";
export const PEON_NPM_LATEST_URL = "https://registry.npmjs.org/%40rnm-dev%2Fpeon/latest";
export function parseNpmPackageRelease(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("npm registry returned invalid package metadata");
    }
    const version = value.version;
    if (typeof version !== "string" || !semver.valid(version)) {
        throw new Error("npm registry returned an invalid package version");
    }
    return { version };
}
export async function fetchLatestNpmRelease(fetchImpl = fetch) {
    const response = await fetchImpl(PEON_NPM_LATEST_URL, {
        headers: { Accept: "application/vnd.npm.install-v1+json" },
    });
    if (!response.ok) {
        throw new Error(`npm registry request failed (${response.status} ${response.statusText})`);
    }
    return parseNpmPackageRelease(await response.json());
}
export function peonNpmSpec(version) {
    if (!semver.valid(version))
        throw new Error("invalid Peon npm version");
    return `${PEON_NPM_PACKAGE}@${version}`;
}
