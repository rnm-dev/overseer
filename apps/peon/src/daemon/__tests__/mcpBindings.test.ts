import assert from "node:assert/strict";
import test from "node:test";
import { McpBindingRegistry, McpConfigAssembler } from "../mcpBindings.js";
import { SESSION_MCP_HEADER, verifySessionMcpCredential } from "../sessionMcpAuth.js";

test("MCP assembler combines project quick links with scoped Armory bindings", () => {
  const registry = new McpBindingRegistry();
  registry.registerArmoryProvider({ snapshotTurn: () => ({
    bindings: [
      { packageId: "google-analytics", bindingId: "binding-google" },
      { packageId: "aws", bindingId: "binding-aws" },
    ],
    unavailable: [{ packageId: "google-play", code: "PACKAGE_NOT_READY", message: "Google Play is updating" }],
    release: () => undefined,
  }) });
  const assembler = new McpConfigAssembler(registry, "http://127.0.0.1:4570");

  const result = assembler.assemble({ sessionId: "session", turnId: "turn", projectId: "project", allowSessionSpawning: false });

  assert.deepEqual(result?.mcpServers, {
    peon_projects: { type: "http", url: "http://127.0.0.1:4570/mcp/projects", headers: {} },
    peon_plugins: { type: "http", url: "http://127.0.0.1:4570/mcp/plugins", headers: { [SESSION_MCP_HEADER]: result?.mcpServers.peon_plugins?.headers[SESSION_MCP_HEADER]! } },
    armory_aws: { type: "http", url: "http://127.0.0.1:4570/mcp/armory/binding-aws", headers: { [SESSION_MCP_HEADER]: result?.mcpServers.armory_aws?.headers[SESSION_MCP_HEADER]! } },
    armory_google_analytics: { type: "http", url: "http://127.0.0.1:4570/mcp/armory/binding-google", headers: { [SESSION_MCP_HEADER]: result?.mcpServers.armory_google_analytics?.headers[SESSION_MCP_HEADER]! } },
  });
  assert.equal(
    result?.allowedTools,
    "mcp__peon_projects__*,mcp__peon_plugins__*,mcp__armory_google_analytics__*,mcp__armory_aws__*",
  );
  assert.deepEqual(result?.unavailableArmoryPackages, [
    { packageId: "google-play", code: "PACKAGE_NOT_READY", message: "Google Play is updating" },
  ]);
});

test("MCP assembler always exposes the Peon project quick-links API", () => {
  const assembler = new McpConfigAssembler(new McpBindingRegistry(), "http://127.0.0.1:4570");
  assert.deepEqual(assembler.assemble(), {
    mcpServers: {
      peon_projects: { type: "http", url: "http://127.0.0.1:4570/mcp/projects", headers: {} },
    },
    allowedTools: "mcp__peon_projects__*",
  });
});

test("root sessions receive a signed orchestration binding while children do not", () => {
  const assembler = new McpConfigAssembler(new McpBindingRegistry(), "http://127.0.0.1:4570");
  const root = assembler.assemble({ sessionId: "root-session", allowSessionSpawning: true })!;
  const credential = root.mcpServers.peon_sessions?.headers[SESSION_MCP_HEADER];
  assert.equal(root.mcpServers.peon_sessions?.url, "http://127.0.0.1:4570/mcp/sessions");
  assert.equal(verifySessionMcpCredential(credential), "root-session");
  assert.match(root.allowedTools, /mcp__peon_sessions__\*/);
  assert.equal(verifySessionMcpCredential(root.mcpServers.peon_plugins?.headers[SESSION_MCP_HEADER]), "root-session");
  assert.match(root.allowedTools, /mcp__peon_plugins__\*/);

  const child = assembler.assemble({ sessionId: "child-session", allowSessionSpawning: false })!;
  assert.equal(child.mcpServers.peon_sessions, undefined);
  assert.doesNotMatch(child.allowedTools, /peon_sessions/);
  assert.equal(verifySessionMcpCredential(child.mcpServers.peon_plugins?.headers[SESSION_MCP_HEADER]), "child-session");
});

test("session MCP credentials reject tampering and malformed values", () => {
  const assembler = new McpConfigAssembler(new McpBindingRegistry(), "http://127.0.0.1:4570");
  const credential = assembler.assemble({ sessionId: "root-session", allowSessionSpawning: true })!
    .mcpServers.peon_sessions!.headers[SESSION_MCP_HEADER]!;
  assert.equal(verifySessionMcpCredential(`${credential.slice(0, -1)}x`), null);
  assert.equal(verifySessionMcpCredential("not-a-token"), null);
  assert.equal(verifySessionMcpCredential(undefined), null);
});
