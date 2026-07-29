import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("dashboard apiPatch returns the same response envelope as other mutation helpers", async () => {
  const requests: Array<{ url: string; init: Record<string, unknown> }> = [];
  const window = {
    location: { port: "4571", protocol: "http:", hostname: "localhost" },
    ACA: {},
  };
  const context = vm.createContext({
    window,
    fetch: async (url: string, init: Record<string, unknown>) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ label: "updated" }),
      };
    },
    XMLHttpRequest: class {},
    FormData: class {},
  });
  const source = readFileSync(path.resolve("src/dashboard/public/lib/api.js"), "utf8");
  vm.runInContext(source, context);

  const apiPatch = (window.ACA as { apiPatch: (path: string, body: unknown) => Promise<unknown> }).apiPatch;
  assert.deepEqual(
    JSON.parse(JSON.stringify(await apiPatch("/api/v1/projects/local", { label: "updated" }))),
    { ok: true, status: 200, body: { label: "updated" } },
  );
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
    url: "http://localhost:4570/api/v1/projects/local",
    init: {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "updated" }),
    },
  }]);
});

test("project settings screen reads and writes identity and follows a renamed key", () => {
  const source = readFileSync(path.resolve("src/dashboard/public/components/ProjectsCard.jsx"), "utf8");
  assert.match(source, /apiGet\(`\/api\/v1\/projects\/\$\{projectKey\}\/settings`\)/);
  assert.match(source, /apiPatch\(`\/api\/v1\/projects\/\$\{projectKey\}\/settings`, \{ key, name, dir \}\)/);
  assert.match(source, /ProjectDocumentation/);
  assert.doesNotMatch(source, /Metadata \(Markdown\)/);
  assert.doesNotMatch(source, /projects\/import/);
  assert.match(source, /navigate\(settingsUpdate\.body\.key\)/);
  assert.match(source, /parts\[1\] === "settings"/);
});

test("new project flow opens the automatic documentation onboarding session", () => {
  const source = readFileSync(path.resolve("src/dashboard/public/components/ProjectsCard.jsx"), "utf8");
  assert.match(source, /body\.onboardingSessionId/);
  assert.match(source, /onSelectSession\(body\.onboardingSessionId\)/);
  assert.match(source, /<ProjectsNewPage[^>]+onSelectSession=\{onSelectSession\}/);
});

test("dashboard exposes explicit app-server and legacy agent selection", () => {
  const settingsSource = readFileSync(path.resolve("src/dashboard/public/components/SettingsCard.jsx"), "utf8");
  const newSessionSource = readFileSync(path.resolve("src/dashboard/public/components/NewSessionScreen.jsx"), "utf8");
  const aiSource = readFileSync(path.resolve("src/dashboard/public/components/AICard.jsx"), "utf8");
  assert.match(settingsSource, /defaultAgent/);
  assert.match(settingsSource, /provider\?\.defaultModel/);
  assert.match(settingsSource, /ai\.defaultReasoningEffort/);
  assert.match(settingsSource, /model\?\.reasoningEfforts/);
  assert.match(settingsSource, /legacy fallback/);
  assert.match(newSessionSource, /catalog\?\.defaultAgent/);
  assert.match(newSessionSource, /provider\.legacy/);
  assert.match(aiSource, /minimumVersion/);
  assert.match(aiSource, /status === "incompatible"/);
  assert.match(aiSource, /Driver:/);
});
