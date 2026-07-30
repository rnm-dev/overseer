import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]),
  );
}

export function auditVendoredContracts(repositoryRoot, contracts) {
  return contracts.map((contract) => {
    const copies = contract.copies.map((relativePath) => {
      const absolutePath = path.resolve(repositoryRoot, relativePath);
      const repositoryPrefix = `${path.resolve(repositoryRoot)}${path.sep}`;
      if (!absolutePath.startsWith(repositoryPrefix)) throw new Error(`contract path escapes repository: ${relativePath}`);
      const bytes = readFileSync(absolutePath);
      let semanticSha256 = null;
      try {
        semanticSha256 = digest(JSON.stringify(canonicalJson(JSON.parse(bytes.toString("utf8")))));
      } catch {
        // Non-JSON contract artifacts still receive an exact byte audit.
      }
      return { path: relativePath, bytes: bytes.byteLength, sha256: digest(bytes), semanticSha256 };
    });
    const hashes = new Set(copies.map((copy) => copy.sha256));
    const semanticHashes = new Set(copies.map((copy) => copy.semanticSha256));
    return {
      id: contract.id,
      identical: hashes.size === 1,
      jsonEquivalent: !semanticHashes.has(null) && semanticHashes.size === 1,
      copies,
    };
  });
}
