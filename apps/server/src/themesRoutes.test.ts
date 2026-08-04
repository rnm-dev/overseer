import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "./server.js";

test("public theme catalog and generated CSS share one source", async () => {
  const app = createServer({ production: false });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    const catalogResponse = await fetch(`${origin}/api/v1/themes`);
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json() as { defaultThemeId: string; themes: Array<{ id: string; tokens: Record<string, string> }> };
    assert.equal(catalog.defaultThemeId, "org.overseer.ironwood");
    assert.equal(catalog.themes.length, 6);

    const cssResponse = await fetch(`${origin}/api/v1/themes.css`);
    assert.equal(cssResponse.status, 200);
    assert.match(cssResponse.headers.get("content-type") ?? "", /^text\/css/);
    const css = await cssResponse.text();
    for (const theme of catalog.themes) {
      assert.match(css, new RegExp(`data-overseer-theme="${theme.id.replaceAll(".", "\\.")}"`));
      assert.match(css, new RegExp(`--ov-canvas: ${theme.tokens["--ov-canvas"]}`));
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
