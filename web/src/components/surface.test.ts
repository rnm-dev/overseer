import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Card } from "../ui";

test("Card renders the canonical app surface and preserves variants", () => {
  const html = renderToStaticMarkup(createElement(Card, { className: "surface--interactive p-4", children: "content" }));

  assert.match(html, /class="surface surface--interactive p-4"/);
  assert.doesNotMatch(html, /\bwarplate\b/);
});
