import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../i18n";
import { formatChannelUptime, PeonConnectionStatusDot } from "./PeonConnectionStatusDot";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

test("connection status tooltip names both channels, shows live uptime, and partial connectivity is yellow", () => {
  const startedAt = Date.now() - 65_000;
  const markup = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(PeonConnectionStatusDot, {
      online: false,
      controlConnected: false,
      transferConnected: true,
      transferConnectedAt: startedAt,
    }),
  ));

  assert.match(markup, /Control Channel: disconnected/);
  assert.match(markup, /Transfer Channel: connected · uptime 1m 5s/);
  assert.match(markup, /statdot--busy/);
  assert.doesNotMatch(markup, /title=/, "status uses the custom JavaScript tooltip instead of the native browser title");
});

test("channel uptime stays compact across duration ranges", () => {
  assert.equal(formatChannelUptime(9_000), "9s");
  assert.equal(formatChannelUptime(125_000), "2m 5s");
  assert.equal(formatChannelUptime(3_720_000), "1h 2m");
  assert.equal(formatChannelUptime(93_600_000), "1d 2h");
});
