import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { ApiError } from "../api";
import { ArmoryConfigurationPanel } from "../pages/peon/ArmoryConfigurationPanel";
import { ArmoryMcpPanel } from "../pages/peon/ArmoryMcpPanel";
import { ArmoryLifecyclePanel, UNINSTALL_PRESERVATION_COPY } from "../pages/peon/ArmoryLifecyclePanel";
import { isPackageReady, PackageCard } from "../pages/peon/PeonArmory";
import {
  ARMORY_SEARCH_DEBOUNCE_MS,
  ArmoryActionGate,
  activeArmoryCapabilities,
  ArmoryRequestGate,
  clearAcceptedTransientValues,
  deleteArmoryConfiguration,
  getArmoryConfiguration,
  getArmoryInventory,
  getArmoryMcp,
  getArmoryOperation,
  getArmoryPackage,
  getArmorySettings,
  isMcpCapable,
  inventoryPath,
  installArmoryPackage,
  operationActive,
  refreshArmory,
  setArmoryPackageEnabled,
  submitArmoryConfiguration,
  uninstallArmoryPackage,
  updateArmoryPackage,
  validateArmoryConfiguration,
  type ArmoryConfiguration,
  type ArmoryOperation,
  type InstalledPackage,
} from "../pages/peon/armoryApi";

const installed: InstalledPackage = {
  id: "heroboard", version: "1.0.0", enabled: false, state: "needs_configuration",
  installedAt: 1, updatedAt: 1, sourceDigest: "digest", configurationStatus: "missing",
  lastError: null, activeOperationId: null,
};

const schema: ArmoryConfiguration = {
  packageId: "heroboard",
  fields: [
    { id: "apiKey", label: "API key", help: "Heroboard API key", type: "secret", required: true },
    { id: "label", label: "Label", type: "text", required: true, validation: { pattern: "^[a-z]+$", maxLength: 8 } },
    { id: "region", label: "Region", type: "select", required: true, options: [{ value: "eu", label: "Europe" }] },
    { id: "certificate", label: "Certificate", type: "file", required: true, validation: { maxLength: 12 } },
  ],
  configured: { apiKey: true },
  hostWrites: ["/exact/host/path", "/another path/config"],
};

test("verified ready packages render the completed inventory card", () => {
  const item = {
    id: "heroboard",
    displayName: "Heroboard",
    summary: "Task coordination for agents.",
    available: true,
    latestVersion: "1.0.0",
    publisher: "RNM",
    documentationUrl: null,
    requirements: { credentials: true, hostWrites: false },
    capabilities: { mcp: true },
    updateAvailable: false,
    installed: { ...installed, enabled: true, state: "ready" as const, configurationStatus: "verified" as const },
  };
  assert.equal(isPackageReady(item), true);
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement("ul", null, createElement(PackageCard, { item }))));
  assert.match(markup, /lucide-cpu/);
  assert.match(markup, /aria-label="Installed and running"/);
  assert.doesNotMatch(markup, /Ready to rock/);
  assert.match(markup, /Enabled · 1\.0\.0/);
  assert.doesNotMatch(markup, /Needs config/);
  assert.equal(isPackageReady({ ...item, installed: { ...item.installed, state: "error", lastError: "failure" } }), false);
  assert.equal(isPackageReady({ ...item, installed: { ...item.installed, enabled: false } }), false);
});

test("package cards use safe icon fallbacks and preserve installed-only/update states", () => {
  const item = {
    id: "local-only", displayName: null, summary: null, available: false, latestVersion: null,
    publisher: null, documentationUrl: null, requirements: null, capabilities: null,
    updateAvailable: true, iconUrl: "javascript:alert(1)", installed,
  };
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement("ul", null, createElement(PackageCard, { item }))));
  assert.match(markup, /lucide-package/);
  assert.match(markup, /lucide-cpu/);
  assert.match(markup, /aria-label="Installed but not running"/);
  assert.match(markup, /text-iron-500/);
  assert.doesNotMatch(markup, /<img|javascript:/);
  assert.match(markup, /This installed package is no longer present in the current catalog/);
  assert.match(markup, /Update available/);
  assert.ok(markup.indexOf("Update available") < markup.indexOf("lucide-cpu"));
});

test("uninstalled package cards reserve the same CPU position with warnings on its left", () => {
  const item = {
    id: "available", displayName: "Available", summary: "Not installed yet.", available: true, latestVersion: "2.0.0",
    publisher: null, documentationUrl: null, requirements: null, capabilities: null,
    updateAvailable: true, iconUrl: null, installed: null,
  };
  const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement("ul", null, createElement(PackageCard, { item }))));
  assert.match(markup, /aria-label="Not installed"/);
  assert.match(markup, /text-iron-500/);
  assert.ok(markup.indexOf("Update available") < markup.indexOf("lucide-cpu"));
});

test("available/installed filters, search, and pagination use scoped GET paths", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request = async <T>(path: string, options?: RequestInit) => { calls.push({ path, options }); return {} as T; };
  await getArmoryInventory("/peon-a", { q: "git tools", view: "available" }, request);
  await getArmoryInventory("/peon-a", { view: "installed", cursor: "opaque+/cursor==" }, request);
  assert.equal(calls[0].path, "/peon-a/armory/packages?q=git+tools&limit=24");
  assert.equal(calls[1].path, "/peon-a/armory/packages?installed=true&limit=24&cursor=opaque%2B%2Fcursor%3D%3D");
  assert.ok(calls.every((call) => call.options?.method === undefined));
});

test("catalog refresh uses the scoped bodyless POST endpoint", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request = async <T>(path: string, options?: RequestInit) => { calls.push({ path, options }); return {} as T; };
  await refreshArmory("/peon-a", request);
  assert.deepEqual(calls, [{ path: "/peon-a/armory/refresh", options: { method: "POST" } }]);
});

test("pagination cursors stay opaque and reset when omitted", () => {
  assert.match(inventoryPath("/p", { cursor: "signed.token/==" }), /cursor=signed.token%2F%3D%3D/);
  assert.equal(inventoryPath("/p", { q: "next" }), "/p/armory/packages?q=next&limit=24");
});

test("request gate rejects stale cross-query and cross-Peon results", () => {
  const gate = new ArmoryRequestGate();
  const oldPeonSearch = gate.begin();
  const newPeonSearch = gate.begin();
  assert.equal(gate.current(oldPeonSearch), false);
  assert.equal(gate.current(newPeonSearch), true);
  gate.clear();
  assert.equal(gate.current(newPeonSearch), false);
  assert.equal(ARMORY_SEARCH_DEBOUNCE_MS, 300);
});

test("lifecycle action gate synchronously rejects double submits and stale Peon responses", () => {
  const gate = new ArmoryActionGate();
  const first = gate.begin();
  assert.equal(typeof first, "number");
  assert.equal(gate.begin(), null);
  assert.equal(gate.current(first!), true);
  gate.clear();
  assert.equal(gate.current(first!), false);
  const nextPeon = gate.begin();
  assert.equal(typeof nextPeon, "number");
  assert.equal(gate.finish(first!), false);
  assert.equal(gate.current(nextPeon!), true);
  assert.equal(gate.finish(nextPeon!), true);
});

test("detail, configuration, MCP discovery, and policy clients emit no mutation requests", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request = async <T>(path: string, options?: RequestInit) => { calls.push({ path, options }); return {} as T; };
  await getArmoryPackage("/p", "rnm/dev tools", request);
  await getArmoryConfiguration("/p", "rnm/dev tools", request);
  await getArmoryMcp("/p", "rnm/dev tools", request);
  await getArmorySettings("/p", request);
  assert.deepEqual(calls.map((call) => call.path), [
    "/p/armory/packages/rnm%2Fdev%20tools",
    "/p/armory/packages/rnm%2Fdev%20tools/configuration",
    "/p/armory/packages/rnm%2Fdev%20tools/mcp",
    "/p/armory/settings",
  ]);
  assert.ok(calls.every((call) => !call.options?.method));
});

test("MCP capability is opt-in and live discovery renders exact tool documentation", () => {
  assert.equal(isMcpCapable({ capabilities: { mcp: true } }), true);
  assert.equal(isMcpCapable({ capabilities: { mcp: false } }), false);
  assert.equal(isMcpCapable({}), false);
  assert.deepEqual(activeArmoryCapabilities({ capabilities: { mcp: true, prompts: true, disabledFeature: false } }), ["mcp", "prompts"]);
  const markup = renderToStaticMarkup(createElement(ArmoryMcpPanel, {
    loading: false, error: null, configured: true, enabled: true, onRetry: () => {},
    details: {
      status: "running", endpoint: "/mcp/armory/heroboard", tools: [{
        name: "create_task",
        description: "Exact description from tools/list.",
        inputSchema: { type: "object", required: ["title"], properties: {
          title: { type: "string", description: "Exact title description." },
          priority: { type: ["string", "null"], description: "Exact priority description." },
        } },
      }],
    },
  }));
  assert.doesNotMatch(markup, /Runtime status|Scoped endpoint/);
  assert.match(markup, /create_task/);
  assert.match(markup, /Exact description from tools\/list\./);
  assert.match(markup, /Exact title description\./);
  assert.match(markup, /string \| null/);
  assert.match(markup, /Required/);
  assert.match(markup, /<details class="group">/);
  assert.doesNotMatch(markup, /<details[^>]* open/);
  assert.match(markup, /<summary[^>]*>[\s\S]*create_task[\s\S]*Exact description from tools\/list\.[\s\S]*<\/summary>/);
});

test("disabled MCP package is a plain-language non-error empty state", () => {
  const markup = renderToStaticMarkup(createElement(ArmoryMcpPanel, {
    details: null, loading: false, error: new ApiError(404, "NOT_FOUND", "not found"),
    configured: false, enabled: false, onRetry: () => {},
  }));
  assert.match(markup, /Tools aren’t available yet/);
  assert.match(markup, /Configure and enable this package to see its available tools\./);
  assert.doesNotMatch(markup, /discovery|schema|Runtime status|Scoped endpoint/i);
  assert.doesNotMatch(markup, /role="alert"/);
});

test("Heroboard and every manifest field type render without configured values or fake secret placeholders", () => {
  const markup = renderToStaticMarkup(createElement(ArmoryConfigurationPanel, {
    base: "/selected-peon", packageId: "heroboard", installed, schema, schemaError: null,
    onRetrySchema: () => {}, onRefresh: async () => {},
  }));
  assert.match(markup, /API key/);
  assert.match(markup, /type="password"/);
  assert.match(markup, /type="text"/);
  assert.match(markup, /<select/);
  assert.match(markup, /type="file"/);
  assert.match(markup, /Configured/);
  assert.match(markup, /required=""/);
  assert.match(markup, /pattern="\^\[a-z\]\+\$"/);
  assert.match(markup, /maxLength="8"/);
  assert.doesNotMatch(markup, /placeholder=/);
  assert.doesNotMatch(markup, /stored-secret|fake-secret/);
  assert.match(markup, /\/exact\/host\/path/);
  assert.match(markup, /\/another path\/config/);
  for (const unsupported of ["Install", "Enable", "Disable", "Update", "Uninstall", "Purge", "Verify now"]) assert.doesNotMatch(markup, new RegExp(`>${unsupported}<`, "i"));
});

test("optional patterned text fields stay empty and opt out of URL and password-manager autofill", () => {
  const markup = renderToStaticMarkup(createElement(ArmoryConfigurationPanel, {
    base: "/workspaces/ws/peons/http%3A%2F%2Fpeon-serik.mesh.rnm%3A4570",
    packageId: "google-analytics",
    installed,
    schema: {
      packageId: "google-analytics",
      fields: [{
        id: "defaultPropertyId",
        label: "Default GA4 property ID",
        type: "text",
        required: false,
        validation: { pattern: "^[0-9]{1,32}$" },
      }],
      configured: {},
      hostWrites: [],
    },
    schemaError: null,
    onRetrySchema: () => {},
    onRefresh: async () => {},
  }));

  assert.match(markup, /name="armory-config-google-analytics-defaultPropertyId"/);
  assert.match(markup, /autoComplete="off"/);
  assert.match(markup, /data-1p-ignore="true"/);
  assert.match(markup, /data-lpignore="true"/);
  assert.match(markup, /readonly=""/);
  assert.match(markup, /value=""/);
  assert.match(markup, /pattern="\^\[0-9\]\{1,32\}\$"/);
  assert.doesNotMatch(markup, /value="http:\/\/peon-serik\.mesh\.rnm:4570"/);
});

test("verified configuration hides the form behind an explicit edit action", () => {
  const markup = renderToStaticMarkup(createElement(ArmoryConfigurationPanel, {
    base: "/selected-peon", packageId: "heroboard",
    installed: { ...installed, enabled: true, state: "ready", configurationStatus: "verified" },
    schema, schemaError: null, onRetrySchema: () => {}, onRefresh: async () => {},
  }));
  assert.match(markup, /Configuration verified/);
  assert.match(markup, />Edit</);
  assert.match(markup, />Delete</);
  assert.match(markup, /aria-haspopup="dialog"/);
  assert.doesNotMatch(markup, /role="dialog"/);
  assert.doesNotMatch(markup, /Everything is set|Configuration is saved|passed verification/);
  assert.doesNotMatch(markup, /type="password"/);
  assert.doesNotMatch(markup, /Save configuration/);
});

test("required, select option, pattern, and maximum-length checks never echo entered values", () => {
  const secret = "do-not-echo";
  const errors = validateArmoryConfiguration(schema, { apiKey: "", label: "TOO-LONG-SECRET", region: "unknown", certificate: "way-too-long-file-content" });
  assert.deepEqual(Object.keys(errors).sort(), ["apiKey", "certificate", "label", "region"]);
  assert.ok(Object.values(errors).every((message) => !message.includes(secret) && !message.includes("TOO-LONG-SECRET") && !message.includes("way-too-long-file-content")));
  const malformed = { ...schema, fields: [{ ...schema.fields[1], validation: { pattern: "[" } }] };
  assert.doesNotThrow(() => validateArmoryConfiguration(malformed, { label: "safe" }));
  assert.equal(validateArmoryConfiguration(schema, { label: "safe", region: "eu", certificate: "cert" }).apiKey, "API key is required.");
});

test("accepted submissions immediately discard secret and file values but retain ordinary values", () => {
  const values = { apiKey: "hb_live_secret", label: "worker", region: "eu", certificate: "file contents" };
  assert.deepEqual(clearAcceptedTransientValues(schema, values), { label: "worker", region: "eu" });
  assert.deepEqual(values, { apiKey: "hb_live_secret", label: "worker", region: "eu", certificate: "file contents" });
});

test("configuration submission is scoped to Overseer path and keeps values out of URLs and responses", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request = async <T>(path: string, options?: RequestInit) => {
    calls.push({ path, options });
    return { operation: { id: "op-1", packageId: "heroboard", kind: "configure", status: "queued", phase: "queued", progress: null, message: "Queued", errorCode: null, startedAt: null, finishedAt: null } } as T;
  };
  const secret = "hb_live_super_secret";
  const response = await submitArmoryConfiguration("/workspaces/ws/peons/selected", "heroboard", { apiKey: secret }, true, request);
  assert.equal(calls[0].path, "/workspaces/ws/peons/selected/armory/packages/heroboard/configuration");
  assert.equal(calls[0].options?.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), { values: { apiKey: secret }, confirmHostWrites: true });
  assert.doesNotMatch(calls[0].path, /hb_live|apiKey/);
  assert.doesNotMatch(JSON.stringify(response), /hb_live|apiKey/);
});

test("managed deletion omits host flags while explicit host deletion sends both confirmations", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request = async <T>(path: string, options?: RequestInit) => { calls.push({ path, options }); return { operation: {} } as T; };
  await deleteArmoryConfiguration("/p", "heroboard", false, request);
  await deleteArmoryConfiguration("/p", "heroboard", true, request);
  assert.deepEqual(JSON.parse(String(calls[0].options?.body)), {});
  assert.deepEqual(JSON.parse(String(calls[1].options?.body)), { includeHost: true, confirmHostWrites: true });
  assert.ok(calls.every((call) => call.options?.method === "DELETE"));
});

test("package enable and disable actions use scoped bodyless POST requests", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request = async <T>(path: string, options?: RequestInit) => { calls.push({ path, options }); return { operation: {} } as T; };
  await setArmoryPackageEnabled("/p", "rnm/dev tools", true, request);
  await setArmoryPackageEnabled("/p", "rnm/dev tools", false, request);
  assert.deepEqual(calls.map((call) => call.path), [
    "/p/armory/packages/rnm%2Fdev%20tools/enable",
    "/p/armory/packages/rnm%2Fdev%20tools/disable",
  ]);
  assert.ok(calls.every((call) => call.options?.method === "POST" && call.options.body === undefined));
});

test("install, durable update, and ordinary uninstall use exact scoped lifecycle requests", async () => {
  const calls: Array<{ path: string; options?: RequestInit }> = [];
  const request = async <T>(path: string, options?: RequestInit) => { calls.push({ path, options }); return { operation: {} } as T; };
  await installArmoryPackage("/selected-peon", "rnm/dev tools", null, request);
  await installArmoryPackage("/selected-peon", "rnm/dev tools", "1.2.3", request);
  await updateArmoryPackage("/selected-peon", "rnm/dev tools", null, request);
  await updateArmoryPackage("/selected-peon", "rnm/dev tools", "2.0.0", request);
  await uninstallArmoryPackage("/selected-peon", "rnm/dev tools", request);
  assert.deepEqual(calls.map(({ path, options }) => [path, options?.method, JSON.parse(String(options?.body))]), [
    ["/selected-peon/armory/packages/rnm%2Fdev%20tools/install", "POST", {}],
    ["/selected-peon/armory/packages/rnm%2Fdev%20tools/install", "POST", { version: "1.2.3" }],
    ["/selected-peon/armory/packages/rnm%2Fdev%20tools/update", "POST", {}],
    ["/selected-peon/armory/packages/rnm%2Fdev%20tools/update", "POST", { version: "2.0.0" }],
    ["/selected-peon/armory/packages/rnm%2Fdev%20tools", "DELETE", {}],
  ]);
  assert.ok(calls.every((call) => !call.path.includes("purge") && !String(call.options?.body).includes("purge")));
  assert.match(UNINSTALL_PRESERVATION_COPY, /Credentials, managed home, configuration, and ownership metadata are preserved/);
});

test("lifecycle mutations preserve stable Peon conflict codes", async () => {
  const request = async <T>(): Promise<T> => { throw new ApiError(409, "OPERATION_IN_PROGRESS", "Another operation is already running"); };
  await assert.rejects(() => installArmoryPackage("/selected-peon", "heroboard", null, request), (error: ApiError) => error.status === 409 && error.code === "OPERATION_IN_PROGRESS");
  await assert.rejects(() => uninstallArmoryPackage("/selected-peon", "heroboard", request), (error: ApiError) => error.status === 409 && error.code === "OPERATION_IN_PROGRESS");
  await assert.rejects(() => updateArmoryPackage("/selected-peon", "heroboard", null, request), (error: ApiError) => error.status === 409 && error.code === "OPERATION_IN_PROGRESS");
});

test("update client preserves Peon 202, 404, and both 409 outcomes", async () => {
  const accepted = await updateArmoryPackage("/p", "heroboard", "2.0.0", async <T>() => ({
    operation: { id: "op-update", packageId: "heroboard", kind: "update", status: "queued", phase: "queued", progress: 0, message: "Queued", errorCode: null, startedAt: null, finishedAt: null },
  }) as T);
  assert.deepEqual([accepted.operation.kind, accepted.operation.status], ["update", "queued"]);

  for (const [status, code] of [[404, "PACKAGE_NOT_ACTIVE"], [409, "NO_UPDATE_AVAILABLE"], [409, "OPERATION_IN_PROGRESS"]] as const) {
    const request = async <T>(): Promise<T> => { throw new ApiError(status, code, "Peon rejected the update"); };
    await assert.rejects(() => updateArmoryPackage("/p", "heroboard", null, request), (error: ApiError) => error.status === status && error.code === code);
  }
});

test("installed packages expose update only when Peon reports one and block it during active operations", () => {
  const update = renderToStaticMarkup(createElement(ArmoryLifecyclePanel, {
    base: "/selected-peon", packageId: "heroboard", installed: { ...installed, state: "ready", configurationStatus: "verified" },
    latestVersion: "2.0.0", updateAvailable: true, onRefresh: async () => {},
  }));
  assert.match(update, />Update to 2\.0\.0</);

  const current = renderToStaticMarkup(createElement(ArmoryLifecyclePanel, {
    base: "/selected-peon", packageId: "heroboard", installed: { ...installed, state: "ready", configurationStatus: "verified" },
    latestVersion: "2.0.0", updateAvailable: false, onRefresh: async () => {},
  }));
  assert.doesNotMatch(current, />Update to/);

  const unknown = renderToStaticMarkup(createElement(ArmoryLifecyclePanel, {
    base: "/selected-peon", packageId: "heroboard", installed: { ...installed, state: "ready", configurationStatus: "verified" },
    latestVersion: "2.0.0", updateAvailable: null, onRefresh: async () => {},
  }));
  assert.doesNotMatch(unknown, />Update to/);

  const busy = renderToStaticMarkup(createElement(ArmoryLifecyclePanel, {
    base: "/selected-peon", packageId: "heroboard", installed: { ...installed, activeOperationId: "op-active" },
    latestVersion: "2.0.0", updateAvailable: true, onRefresh: async () => {},
  }));
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Update to 2\.0\.0<\/button>/);
});

test("uninstalled packages offer versioned install while active operations block duplicate lifecycle actions", () => {
  const available = renderToStaticMarkup(createElement(ArmoryLifecyclePanel, {
    base: "/selected-peon", packageId: "heroboard", installed: null, latestVersion: "2.0.0",
    versions: [
      { version: "2.0.0", minPeonVersion: "1.0.0", platforms: [{ os: "linux", arch: "x64" }], archive: { url: "https://example.test/a", size: 1, sha256: "a" } },
      { version: "1.0.0", minPeonVersion: "1.0.0", platforms: [{ os: "linux", arch: "x64" }], archive: { url: "https://example.test/b", size: 1, sha256: "b" } },
    ], onRefresh: async () => {},
  }));
  assert.match(available, /Install latest/);
  assert.match(available, /2\.0\.0 \(latest\)/);
  assert.match(available, /1\.0\.0/);

  const busy = renderToStaticMarkup(createElement(ArmoryLifecyclePanel, {
    base: "/selected-peon", packageId: "heroboard", installed: { ...installed, activeOperationId: "op-active" }, onRefresh: async () => {},
  }));
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Uninstall/);
  assert.match(busy, /<button[^>]*disabled=""[^>]*>Enable package/);
  assert.doesNotMatch(busy, /Purge/);
});

test("runtime panel makes configured-but-disabled state and action explicit", () => {
  const markup = renderToStaticMarkup(createElement(ArmoryLifecyclePanel, {
    base: "/p", packageId: "heroboard",
    installed: { ...installed, state: "ready", configurationStatus: "verified" },
    onRefresh: async () => {},
  }));
  assert.match(markup, /Package lifecycle/);
  assert.match(markup, /Configuration is ready, but the package is not active\./);
  assert.match(markup, />Enable package</);
  assert.match(markup, /<dt[^>]*>Runtime<\/dt><dd[^>]*>Disabled<\/dd>/);
  assert.match(markup, /<dt[^>]*>Configuration<\/dt><dd[^>]*>verified<\/dd>/);
});

test("operation reads model queued, configure/verify progress, success, and stable terminal failure", async () => {
  const operations: ArmoryOperation[] = [
    { id: "op", packageId: "heroboard", kind: "configure", status: "queued", phase: "queued", progress: null, message: "Queued", errorCode: null, startedAt: null, finishedAt: null },
    { id: "op", packageId: "heroboard", kind: "configure", status: "running", phase: "configure", progress: 35, message: "Configuring", errorCode: null, startedAt: 1, finishedAt: null },
    { id: "op", packageId: "heroboard", kind: "configure", status: "running", phase: "verify", progress: 80, message: "Verifying", errorCode: null, startedAt: 1, finishedAt: null },
    { id: "op", packageId: "heroboard", kind: "configure", status: "success", phase: "complete", progress: 100, message: "Ready", errorCode: null, startedAt: 1, finishedAt: 2 },
  ];
  let index = 0;
  const request = async <T>() => ({ operation: operations[index++] }) as T;
  const seen = [];
  for (let i = 0; i < operations.length; i++) seen.push((await getArmoryOperation("/p", "op", request)).operation);
  assert.deepEqual(seen.map((operation) => [operation.status, operation.phase, operation.progress]), [["queued", "queued", null], ["running", "configure", 35], ["running", "verify", 80], ["success", "complete", 100]]);
  assert.equal(operationActive(seen[0]), true);
  assert.equal(operationActive(seen[3]), false);
  const failure = { ...operations[3], status: "failure" as const, errorCode: "VERIFY_FAILED", message: "Verification failed" };
  assert.equal(failure.errorCode, "VERIFY_FAILED");
});

test("409 operation-in-progress propagates without modifying entered values", async () => {
  const values = { apiKey: "still-present-for-immediate-error" };
  const request = async <T>(): Promise<T> => { throw new ApiError(409, "OPERATION_IN_PROGRESS", "Another operation is already running"); };
  await assert.rejects(() => submitArmoryConfiguration("/p", "heroboard", values, false, request), (error: ApiError) => error.code === "OPERATION_IN_PROGRESS");
  assert.deepEqual(values, { apiKey: "still-present-for-immediate-error" });
});

test("configuration API errors cannot echo submitted values", async () => {
  const secret = "hb_live_must_not_escape";
  const request = async <T>(): Promise<T> => { throw new ApiError(400, secret, `Invalid value: ${secret}`); };
  await assert.rejects(
    () => submitArmoryConfiguration("/p", "heroboard", { apiKey: secret }, false, request),
    (error: ApiError) => error.status === 400
      && error.code === "CONFIGURATION_REJECTED"
      && error.message === "Peon rejected the configuration."
      && !JSON.stringify(error).includes(secret),
  );
});
