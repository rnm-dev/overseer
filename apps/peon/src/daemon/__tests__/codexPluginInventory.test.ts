import assert from "node:assert/strict";
import test from "node:test";
import { codexInstalledPlugins } from "../providers/codexPluginInventory.js";

test("cached plugin inventory excludes marketplace suggestions and keeps local versions", async () => {
  let stopped = false;
  const result = await codexInstalledPlugins("unused", {
    start: async () => {}, stop: async () => { stopped = true; },
    request: async <T>(method: string, params: unknown) => {
      assert.equal(method, "plugin/list"); assert.deepEqual(params, { forceRefetch: false });
      return { marketplaces: [{ name: "catalog", plugins: [
        { id: "one@catalog", name: "one", installed: true, enabled: false, localVersion: "1", version: "2" },
        { id: "two@catalog", name: "two", installed: false },
      ] }] } as T;
    },
  });
  assert.equal(stopped, true);
  assert.equal(result.length, 1);
  assert.equal(result[0].version, "1"); assert.equal(result[0].enabled, false);
  assert.equal(result[0].marketplaceName, "catalog");
});

test("failed or malformed inventory still stops its temporary runtime", async () => {
  for (const fail of [true, false]) {
    let stopped = false;
    await assert.rejects(codexInstalledPlugins("unused", {
      start: async () => {}, stop: async () => { stopped = true; },
      request: async <T>() => { if (fail) throw new Error("timeout"); return {} as T; },
    }));
    assert.equal(stopped, true);
  }
});
