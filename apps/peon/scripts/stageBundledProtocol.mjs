import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const protocolRoot = path.join(repositoryRoot, "packages", "protocol");
const destination = path.join(packageRoot, "node_modules", "@rnm-dev", "protocol");

const peonManifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
const protocolManifest = JSON.parse(fs.readFileSync(path.join(protocolRoot, "package.json"), "utf8"));
const expectedRange = `^${protocolManifest.version}`;

if (peonManifest.dependencies?.[protocolManifest.name] !== expectedRange) {
  throw new Error(
    `Peon dependency ${peonManifest.dependencies?.[protocolManifest.name] ?? "<missing>"} does not match bundled ${protocolManifest.name}@${protocolManifest.version}`,
  );
}

fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });

for (const entry of [
  "LICENSE",
  "README.md",
  "PROTOCOL.md",
  "package.json",
  "dist",
  "reverse-command-v1",
]) {
  fs.cpSync(path.join(protocolRoot, entry), path.join(destination, entry), {
    recursive: true,
  });
}

console.error(`Staged bundled ${protocolManifest.name}@${protocolManifest.version}.`);
