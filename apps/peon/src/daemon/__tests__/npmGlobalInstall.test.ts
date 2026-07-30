import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import {
  globalInstallArgs,
  globalInstallPrefix,
  rollbackPackArgs,
} from "../../cli/npmGlobalInstall.js";

describe("global npm installation", () => {
  it("derives the prefix from unscoped and scoped package roots", () => {
    assert.equal(
      globalInstallPrefix(path.join("/home/peon/.local/lib/node_modules/peon")),
      path.join("/home/peon/.local"),
    );
    assert.equal(
      globalInstallPrefix(path.join("/home/peon/.local/lib/node_modules/@rnm-dev/peon")),
      path.join("/home/peon/.local"),
    );
  });

  it("refuses non-global and nested dependency roots", () => {
    assert.throws(
      () => globalInstallPrefix(path.join("/srv/overseer/apps/peon")),
      /cannot derive the global npm prefix/,
    );
    assert.throws(
      () => globalInstallPrefix(path.join("/prefix/lib/node_modules/outer/node_modules/peon")),
      /cannot derive the global npm prefix/,
    );
  });

  it("pins replacement installs to the current package prefix", () => {
    assert.deepEqual(
      globalInstallArgs(
        path.join("/home/peon/.local/lib/node_modules/@rnm-dev/peon"),
        "/tmp/peon-0.11.3.tgz",
      ),
      [
        "install",
        "-g",
        "--prefix",
        path.join("/home/peon/.local"),
        "/tmp/peon-0.11.3.tgz",
      ],
    );
  });

  it("packs rollback archives without running distribution lifecycle scripts", () => {
    assert.deepEqual(
      rollbackPackArgs("/prefix/lib/node_modules/@rnm-dev/peon", "/tmp/rollback"),
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--pack-destination",
        "/tmp/rollback",
        "/prefix/lib/node_modules/@rnm-dev/peon",
      ],
    );
  });
});
