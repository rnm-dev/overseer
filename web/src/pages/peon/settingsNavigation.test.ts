import assert from "node:assert/strict";
import test from "node:test";
import { peonSettingsPath, peonSettingsTabFromPath, SOUL_EDITOR_ROWS } from "./settingsNavigation";

test("Peon settings paths encode identifiers and keep Armory package details nested", () => {
  assert.equal(peonSettingsPath("peon/a"), "/peons/peon%2Fa/settings");
  assert.equal(peonSettingsPath("peon/a", "agent"), "/peons/peon%2Fa/settings/agent");
  assert.equal(peonSettingsPath("peon/a", "armory", "rnm/dev tools"), "/peons/peon%2Fa/settings/armory/rnm%2Fdev%20tools");
});

test("nested Armory details retain their settings tab and Soul uses the expanded editor", () => {
  assert.equal(peonSettingsTabFromPath("/peons/a/settings"), "general");
  assert.equal(peonSettingsTabFromPath("/peons/a/settings/agent"), "agent");
  assert.equal(peonSettingsTabFromPath("/peons/a/settings/armory/rnm%2Fdev"), "armory");
  assert.equal(SOUL_EDITOR_ROWS, 16);
});
