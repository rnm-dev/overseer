import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("file bodies, mutations, attachments and listings use only Fleet HTTP", async () => {
  const source = await readFile(new URL("./routes/peons/projects.ts", import.meta.url), "utf8");
  assert.match(source, /proxyFileDownload/);
  assert.match(source, /proxyFileUpload/);
  assert.match(source, /proxyUpload/);
  assert.match(source, /proxyGet/);
  assert.match(source, /projectFileProxyQuery/);
  assert.doesNotMatch(source, /peonTransfer|FileTransport|streamProjectFile|uploadPeon|movePeon|deletePeon/);
});
