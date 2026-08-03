import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../../i18n";
import { PLUGIN_INQUIRY_ACTIONS_CLASS, PLUGIN_INQUIRY_CARD_CLASS, PluginInquiryCard } from "./PluginInquiryCard";
import type { PluginInstallInquiry } from "./pluginInquiries";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function render(status: PluginInstallInquiry["status"]) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(PluginInquiryCard, {
    inquiry: {
      version: "inquiry-v1",
      inquiryId: "public-inquiry-id",
      kind: "managed_plugin_install",
      status,
      plugin: { id: "posthog", name: "posthog", displayName: "PostHog", description: null, developerName: "PostHog", category: "Analytics", capabilities: [], authPolicy: "ON_INSTALL", installPolicy: "AVAILABLE", installed: false },
      sessionId: "session-1",
      createdAt: "2029-12-31T23:50:00.000Z",
      expiresAt: "2030-01-01T00:00:00.000Z",
      updatedAt: "2029-12-31T23:50:00.000Z",
      respondedBy: null,
      terminalCode: null,
      authPolicy: null,
      appsNeedingAuth: [],
    },
    onInstall: () => undefined,
    onCancel: () => undefined,
  })));
}

test("pending card identifies the catalog and exposes two keyboard buttons without stealing focus", () => {
  const markup = render("pending");
  assert.match(markup, /Analytics/);
  assert.match(markup, /PostHog/);
  assert.match(markup, /<button[^>]*>Cancel<\/button>/);
  assert.match(markup, /<button[^>]*>Install<\/button>/);
  assert.doesNotMatch(markup, /autofocus/);
  assert.doesNotMatch(markup, /nativeRequestId|runtimeHandle|authUrl/);
});

test("terminal and running states cannot trigger duplicate actions", () => {
  for (const status of ["installing", "installed", "auth_required", "expired", "cancelled", "refused", "failed", "stale"] as const) {
    const markup = render(status);
    assert.doesNotMatch(markup, /<button/);
    assert.match(markup, new RegExp(`data-plugin-inquiry-status="${status}"`));
  }
});

test("card follows theme primitives and collapses actions on narrow phones", () => {
  assert.match(PLUGIN_INQUIRY_CARD_CLASS, /\bsurface\b/);
  assert.match(PLUGIN_INQUIRY_CARD_CLASS, /\bmax-w-xl\b/);
  assert.match(PLUGIN_INQUIRY_ACTIONS_CLASS, /max-\[360px\]:grid-cols-1/);
  assert.match(PLUGIN_INQUIRY_ACTIONS_CLASS, /grid-cols-2/);
});

test("installing motion honors reduced-motion preferences", () => {
  assert.match(render("installing"), /motion-reduce:animate-none/);
});
