import assert from "node:assert/strict";
import test from "node:test";
import { McpBindingRegistry, McpConfigAssembler } from "../mcpBindings.js";
import { SESSION_MCP_HEADER, verifySessionMcpCredential } from "../sessionMcpAuth.js";

test("MCP assembler combines project quick links with scoped Armory bindings", () => {
  const registry = new McpBindingRegistry();
  registry.exposeArmoryPackage("google-analytics");
  registry.exposeArmoryPackage("aws");
  const assembler = new McpConfigAssembler(registry, "http://127.0.0.1:4570");

  const result = assembler.assemble();

  assert.deepEqual(result?.mcpServers, {
    peon_projects: { type: "http", url: "http://127.0.0.1:4570/mcp/projects", headers: {} },
    armory_aws: { type: "http", url: "http://127.0.0.1:4570/mcp/armory/aws", headers: {} },
    armory_google_analytics: { type: "http", url: "http://127.0.0.1:4570/mcp/armory/google-analytics", headers: {} },
  });
  assert.equal(
    result?.allowedTools,
    "mcp__peon_projects__*,mcp__armory_aws__*,mcp__armory_google_analytics__*",
  );
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

  const child = assembler.assemble({ sessionId: "child-session", allowSessionSpawning: false })!;
  assert.equal(child.mcpServers.peon_sessions, undefined);
  assert.doesNotMatch(child.allowedTools, /peon_sessions/);
});

test("session MCP credentials reject tampering and malformed values", () => {
  const assembler = new McpConfigAssembler(new McpBindingRegistry(), "http://127.0.0.1:4570");
  const credential = assembler.assemble({ sessionId: "root-session", allowSessionSpawning: true })!
    .mcpServers.peon_sessions!.headers[SESSION_MCP_HEADER]!;
  assert.equal(verifySessionMcpCredential(`${credential.slice(0, -1)}x`), null);
  assert.equal(verifySessionMcpCredential("not-a-token"), null);
  assert.equal(verifySessionMcpCredential(undefined), null);
});
