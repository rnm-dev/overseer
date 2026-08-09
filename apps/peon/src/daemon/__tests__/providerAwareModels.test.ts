import assert from "node:assert/strict";
import test from "node:test";
import {
  aiProviders,
  canonicalModel,
  isModelForAgent,
  modelCatalog,
  providerDefaultModel,
  reasoningEffortsForModel,
  resolveModel,
} from "../providers/modelCatalog.js";

test("models and aliases are provider-aware and canonicalized", () => {
  assert.equal(canonicalModel("codex-app-server", "gpt-5.4"), "gpt-5.4");
  assert.equal(canonicalModel("claude-code", "sonnet"), "claude-sonnet-5");
  assert.equal(canonicalModel("claude-code", "opus"), "claude-opus-5");
  assert.equal(canonicalModel("claude-code", "haiku"), "claude-haiku-4-5-20251001");
  assert.equal(isModelForAgent("codex-app-server", "sonnet"), false);
  assert.equal(isModelForAgent("claude-code", "gpt-5.4"), false);

  const providers = aiProviders();
  const codexAlias = providers.find((provider) => provider.agent === "codex-app-server")?.models.find((model) => model.alias);
  if (codexAlias?.alias) assert.equal(canonicalModel("codex-app-server", codexAlias.alias), codexAlias.id);
  assert.deepEqual(
    reasoningEffortsForModel("codex-app-server", "gpt-5.6-sol").filter((effort) => effort.default).map((effort) => effort.id),
    ["low"],
  );
  assert.deepEqual(
    reasoningEffortsForModel("claude-code", "claude-opus-5").filter((effort) => effort.default).map((effort) => effort.id),
    ["high"],
  );
  assert.deepEqual(reasoningEffortsForModel("claude-code", "haiku"), []);
});

test("catalog marks only the saved provider's effective default", () => {
  const providers = modelCatalog("codex-app-server", "gpt-5.4", "xhigh");
  assert.equal(providers.find((provider) => provider.agent === "codex-app-server")?.models.find((model) => model.default)?.id, "gpt-5.4");
  assert.equal(
    providers.find((provider) => provider.agent === "codex-app-server")
      ?.models.find((model) => model.default)
      ?.reasoningEfforts?.find((effort) => effort.default)?.id,
    "xhigh",
  );
  assert.equal(providers.find((provider) => provider.agent === "claude-code")?.models.some((model) => model.default), false);

  const builtin = modelCatalog("codex-app-server", null);
  const appServer = builtin.find((provider) => provider.agent === "codex-app-server");
  assert.equal(appServer?.visible, true);
  assert.equal(appServer?.legacy, undefined);
  assert.equal(appServer?.defaultModel, providerDefaultModel("codex-app-server"));
  assert.equal((appServer?.status as { status?: string })?.status, "stopped");
});

test("session model precedence never crosses providers", () => {
  assert.equal(resolveModel("codex-app-server", undefined, undefined, "codex-app-server", "gpt-5.4"), "gpt-5.4");
  assert.equal(resolveModel("claude-code", undefined, undefined, "codex-app-server", "gpt-5.4"), providerDefaultModel("claude-code"));
  assert.equal(resolveModel("codex-app-server", "gpt-5.5", "gpt-5.4", "codex-app-server", "gpt-5.6-sol"), "gpt-5.5");
  assert.equal(resolveModel("codex-app-server", undefined, "gpt-5.4", "claude-code", "sonnet"), "gpt-5.4");
});
