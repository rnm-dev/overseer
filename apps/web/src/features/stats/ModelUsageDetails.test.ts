import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../shared/i18n";
import { ModelUsageDetails } from "./PeonStats";
import type { ByModel } from "./statsModel";

(globalThis as typeof globalThis & { React: typeof React }).React = React;
function render(model: ByModel) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ModelUsageDetails, { model, providerTokens: 200 })));
}

test("model detail exposes exclusive buckets, provider share and weighted cache rate", () => {
  const html = render({ model: "gpt-model-with-a-very-long-name", totalTokens: 100,
    inputTokens: 10, cacheReadTokens: 60, cacheCreationTokens: 10, outputTokens: 20,
    usagePartialTurns: 0, usageLegacyTurns: 0, reasoningOutputTokens: 12 });
  assert.match(html, /75.0%/);
  assert.match(html, /50.0%/);
  assert.match(html, /Provider reported/);
  assert.match(html, /12 reported reasoning tokens within output/);
  assert.match(html, /break-all/);
  assert.match(html, /flex-wrap/);
});

test("model detail does not invent cache efficiency for unsupported or partial fields", () => {
  const html = render({ model: "legacy", totalTokens: 100, cacheReadTokens: 60, usagePartialTurns: 1,
    cacheBreakdownComplete: false });
  assert.match(html, /Partial capture/);
  assert.match(html, /Cache breakdown is incomplete/);
  assert.doesNotMatch(html, /Input served from cache/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});
