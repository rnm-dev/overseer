import { readFileSync } from "node:fs";

export function routeEnrollment(cell) {
  if (cell.claimStarted) return "peon-claim-v1";
  return cell.claimAdvertised ? "peon-claim-v1" : "legacy-enroll";
}

export function runClaimConformance(document, securityVectors) {
  const operations = new Set(securityVectors.goldenCases?.map((entry) => entry.operation));
  const missingOperations = document.requiredOperations.filter((operation) => !operations.has(operation));
  const mixedVersion = document.mixedVersion.map((cell) => ({
    ...cell,
    actualRoute: routeEnrollment(cell),
    passed: routeEnrollment(cell) === cell.route,
  }));
  const operationalChecks = document.operationalChecks.map((check) => ({
    ...check, blocked: check.status === "blocked", passed: false,
  }));
  const errors = [];
  if (securityVectors.capability !== document.capability) errors.push("capability mismatch");
  if (securityVectors.goldenCases.length < document.minimumGoldenCases) errors.push(`expected at least ${document.minimumGoldenCases} golden cases`);
  if (missingOperations.length) errors.push(`missing operations: ${missingOperations.join(", ")}`);
  if (mixedVersion.some((cell) => !cell.passed)) errors.push("mixed-version route mismatch");
  if (new Set(document.faultCoverage).size !== document.faultCoverage.length) errors.push("duplicate fault coverage");
  return {
    capability: document.capability,
    goldenCases: securityVectors.goldenCases.length,
    operations: [...operations].sort(),
    mixedVersion,
    faultCoverage: [...document.faultCoverage],
    operationalChecks,
    passed: errors.length === 0,
    errors,
  };
}

export function loadClaimSecurityVectors(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}
