import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("the mobile viewport disables iOS page zoom", async () => {
  const html = await readFile(new URL("../../index.html", import.meta.url), "utf8");
  const viewport = html.match(/<meta name="viewport" content="([^"]+)" \/>/)?.[1] ?? "";

  assert.match(viewport, /maximum-scale=1(?:\.0)?/);
  assert.match(viewport, /user-scalable=no/);
  assert.match(viewport, /viewport-fit=cover/);
});
