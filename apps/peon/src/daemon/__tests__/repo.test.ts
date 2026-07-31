import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitCheckoutRoot, isGitCheckout, readCheckoutSha } from "../../shared/repo.js";

test("recognizes a package nested inside a monorepo checkout", () => {
  const checkout = mkdtempSync(path.join(os.tmpdir(), "peon-monorepo-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: checkout });
    const packageRoot = path.join(checkout, "apps", "peon");
    mkdirSync(packageRoot, { recursive: true });

    assert.equal(gitCheckoutRoot(packageRoot), checkout);
    assert.equal(isGitCheckout(packageRoot), true);
    assert.equal(readCheckoutSha(packageRoot), null);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});

test("does not treat an extracted package as a checkout", () => {
  const packageRoot = mkdtempSync(path.join(os.tmpdir(), "peon-package-"));
  try {
    assert.equal(gitCheckoutRoot(packageRoot), null);
    assert.equal(isGitCheckout(packageRoot), false);
    assert.equal(readCheckoutSha(packageRoot), null);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("does not mistake a global package inside an NVM checkout for Peon source", () => {
  const nvmRoot = mkdtempSync(path.join(os.tmpdir(), "peon-nvm-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: nvmRoot });
    const packageRoot = path.join(
      nvmRoot,
      "versions",
      "node",
      "v22.22.0",
      "lib",
      "node_modules",
      "@rnm-dev",
      "peon",
    );
    mkdirSync(packageRoot, { recursive: true });

    assert.equal(gitCheckoutRoot(packageRoot), null);
    assert.equal(isGitCheckout(packageRoot), false);
    assert.equal(readCheckoutSha(packageRoot), null);
  } finally {
    rmSync(nvmRoot, { recursive: true, force: true });
  }
});
