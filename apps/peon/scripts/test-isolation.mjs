import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const marker = Symbol.for("peon.test-isolation");

if (!globalThis[marker]) {
  const root = mkdtempSync(path.join(os.tmpdir(), `peon-test-${process.pid}-`));
  const config = path.join(root, "config");
  const state = path.join(root, "state");
  const data = path.join(root, "data");

  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(data, { recursive: true });

  // Every Node test worker imports this file independently. Always replace
  // inherited paths so parallel workers cannot share mutable Peon state.
  process.env.XDG_CONFIG_HOME = config;
  process.env.XDG_STATE_HOME = state;
  process.env.XDG_DATA_HOME = data;
  process.env.PEON_TEST_ISOLATED = "1";
  globalThis[marker] = root;

  process.once("exit", () => {
    rmSync(root, { recursive: true, force: true });
  });
}
