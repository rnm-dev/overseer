#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const dryRun = process.argv.includes("--dry-run");
const preflight = process.argv.includes("--preflight");
if (dryRun && preflight) throw new Error("--dry-run and --preflight cannot be combined");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (typeof pkg.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error("package.json has an invalid SemVer version");
}

function releaseBaseUrl() {
  const base = new URL(process.env.OVERSEER_RELEASE_URL || "https://overseer.rnm.dev");
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") {
    throw new Error("OVERSEER_RELEASE_URL must use HTTPS unless it is loopback");
  }
  return base;
}

function tokenFromProjectEnv() {
  const envFile = path.join(root, ".env.release.local");
  if (!existsSync(envFile)) return null;
  const assignment = readFileSync(envFile, "utf8")
    .split(/\r?\n/)
    .find((line) => /^\s*OVERSEER_RELEASE_TOKEN\s*=/.test(line));
  if (!assignment) return null;
  const value = assignment.slice(assignment.indexOf("=") + 1).trim();
  const unquoted = (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) ? value.slice(1, -1) : value;
  return unquoted || null;
}

// Keep release authentication owned by the Peon project. Never inspect sibling
// repositories or deployment recipes, and never print the resolved token.
function publisherToken() {
  if (process.env.OVERSEER_RELEASE_TOKEN) {
    return { token: process.env.OVERSEER_RELEASE_TOKEN, source: "environment" };
  }
  const projectToken = tokenFromProjectEnv();
  if (projectToken) {
    return { token: projectToken, source: "project-env" };
  }
  if (process.platform === "darwin") {
    try {
      const token = execFileSync("security", [
        "find-generic-password",
        "-s", "dev.peon.release-peon",
        "-a", "OVERSEER_RELEASE_TOKEN",
        "-w",
      ], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (token) return { token, source: "project-keychain" };
    } catch {
      // Report the generic setup error below.
    }
  }
  throw new Error(
    "release credential is not configured for Peon "
    + "(export OVERSEER_RELEASE_TOKEN, add ignored .env.release.local, or configure the dev.peon.release-peon keychain item)",
  );
}

const base = dryRun ? null : releaseBaseUrl();
const credential = dryRun ? null : publisherToken();

if (preflight) {
  console.log(JSON.stringify({
    ready: true,
    version: pkg.version,
    registryOrigin: base.origin,
    authentication: credential.source,
  }, null, 2));
  process.exit(0);
}

const temporaryDir = mkdtempSync(path.join(os.tmpdir(), "peon-release-"));
try {
  const output = execFileSync("npm", ["pack", "--json", "--pack-destination", temporaryDir, root], {
    cwd: root,
    encoding: "utf8",
  });
  const packed = JSON.parse(output);
  if (!Array.isArray(packed) || typeof packed[0]?.filename !== "string") throw new Error("npm pack did not return an archive filename");
  const archive = path.join(temporaryDir, packed[0].filename);
  const sizeBytes = statSync(archive).size;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const sha256 = hash.digest("hex");

  if (dryRun) {
    console.log(JSON.stringify({ version: pkg.version, sizeBytes, sha256 }, null, 2));
    process.exitCode = 0;
  } else {
    const upload = new URL(`/api/releases/${encodeURIComponent(pkg.version)}`, base.origin);
    const response = await fetch(upload, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(sizeBytes),
        "Peon-Content-Sha256": sha256,
      },
      body: createReadStream(archive),
      duplex: "half",
    });
    const text = await response.text();
    let responseBody;
    try { responseBody = text ? JSON.parse(text) : {}; } catch { responseBody = {}; }
    if (!response.ok) throw new Error(`release upload failed (${response.status} ${response.statusText}): ${responseBody.error || "unknown server error"}`);
    const body = responseBody.release && typeof responseBody.release === "object" ? responseBody.release : responseBody;
    const returnedSize = body.sizeBytes ?? body.size;
    if (body.version !== undefined && body.version !== pkg.version) throw new Error("registry returned a different release version");
    if (returnedSize !== undefined && returnedSize !== sizeBytes) throw new Error("registry returned a different archive size");
    if (body.sha256 !== undefined && String(body.sha256).toLowerCase() !== sha256) throw new Error("registry returned a different archive SHA-256");
    console.log(JSON.stringify({ published: true, version: pkg.version, sizeBytes, sha256 }, null, 2));
  }
} finally {
  rmSync(temporaryDir, { recursive: true, force: true });
}
