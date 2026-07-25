import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Card, ContentHeaderLayout } from "../ui";

test("Card renders the canonical app surface and preserves variants", () => {
  const html = renderToStaticMarkup(createElement(Card, { className: "surface--interactive p-4", children: "content" }));

  assert.match(html, /class="surface surface--interactive p-4"/);
  assert.doesNotMatch(html, /\bwarplate\b/);
});

test("shared content headers align identity, metadata, actions, and notices", () => {
  const html = renderToStaticMarkup(createElement(ContentHeaderLayout, {
    identity: createElement("span", null, "Identity"),
    metadata: createElement("span", null, "Metadata"),
    actions: createElement("button", null, "Action"),
    notices: createElement("p", null, "Notice"),
  }));

  assert.match(html, /space-y-1\.5 px-3 py-2\.5 sm:px-6/);
  assert.match(html, /min-h-7 gap-3/);
  assert.match(html, /flex min-w-0 flex-1 items-center gap-1\.5/);
  assert.match(html, /flex flex-none items-center gap-2/);
  assert.match(html, /Identity.*Metadata.*Action.*Notice/);
});

test("compact mobile content headers reuse the slots without fixed-pane padding", () => {
  const html = renderToStaticMarkup(createElement(ContentHeaderLayout, {
    compact: true,
    metadataPlacement: "below",
    identity: createElement("span", null, "Session"),
    metadata: createElement("span", null, "Stats"),
    actions: createElement("button", null, "Menu"),
  }));

  assert.match(html, /class="min-w-0 flex-1"/);
  assert.match(html, /flex min-w-0 flex-1 flex-col justify-center/);
  assert.match(html, /Session.*Stats.*Menu/);
  assert.doesNotMatch(html, /px-3 py-2\.5/);
});
