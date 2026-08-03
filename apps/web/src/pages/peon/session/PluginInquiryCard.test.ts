import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../../../i18n";
import { PLUGIN_INQUIRY_ACTIONS_CLASS, PLUGIN_INQUIRY_CARD_CLASS, PluginInquiryCard } from "./PluginInquiryCard";
import type { PluginInstallInquiry } from "./pluginInquiries";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

function render(status: PluginInstallInquiry["status"], appsNeedingAuth?: PluginInstallInquiry["appsNeedingAuth"]) {
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
      appsNeedingAuth: appsNeedingAuth ?? (status === "auth_required" ? [{ id: "posthog-app", name: "PostHog", category: "Analytics", description: null }] : []),
    },
    authHrefForApp: (appId: string) => `/api/workspaces/workspace-1/peons/peon-1/sessions/session-1/inquiries/public-inquiry-id/auth/${appId}`,
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

test("terminal and running states cannot trigger duplicate install actions", () => {
  for (const status of ["installing", "installed", "expired", "cancelled", "refused", "failed", "stale"] as const) {
    const markup = render(status);
    assert.doesNotMatch(markup, /<button/);
    assert.match(markup, new RegExp(`data-plugin-inquiry-status="${status}"`));
  }
});

test("auth-required card exposes only the safe same-origin sign-in launch", () => {
  const markup = render("auth_required");
  assert.match(markup, /<a class="btn btn-accent btn-sm" href="\/api\/workspaces\/workspace-1\/peons\/peon-1\/sessions\/session-1\/inquiries\/public-inquiry-id\/auth\/posthog-app" target="_blank" rel="noreferrer">Sign in<\/a>/);
  assert.doesNotMatch(markup, /<button/);
  assert.doesNotMatch(markup, /installUrl|posthog\.com|authorizationUrl/);
});

test("multiple apps get distinct compact sign-in launches", () => {
  const markup = render("auth_required", [
    { id: "analytics-app", name: "Analytics", category: null, description: null },
    { id: "warehouse-app", name: "Warehouse", category: null, description: null },
  ]);
  assert.match(markup, /auth\/analytics-app[^>]*>Sign in to Analytics<\/a>/);
  assert.match(markup, /auth\/warehouse-app[^>]*>Sign in to Warehouse<\/a>/);
});

test("card follows theme primitives and collapses actions on narrow phones", () => {
  assert.match(PLUGIN_INQUIRY_CARD_CLASS, /\bsurface\b/);
  assert.match(PLUGIN_INQUIRY_CARD_CLASS, /\bmr-auto\b/);
  assert.doesNotMatch(PLUGIN_INQUIRY_CARD_CLASS, /\bmx-auto\b/);
  assert.match(PLUGIN_INQUIRY_CARD_CLASS, /\bmax-w-md\b/);
  assert.match(PLUGIN_INQUIRY_ACTIONS_CLASS, /max-\[360px\]:grid-cols-1/);
  assert.match(PLUGIN_INQUIRY_ACTIONS_CLASS, /grid-cols-2/);
});

test("installing motion honors reduced-motion preferences", () => {
  assert.match(render("installing"), /motion-reduce:animate-none/);
});
