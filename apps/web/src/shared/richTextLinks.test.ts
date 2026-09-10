import assert from "node:assert/strict";
import test from "node:test";
import { localFilePath } from "./RichText";

test("a file:// link names the path a Peon can actually open", () => {
  assert.equal(localFilePath("file:///rnm/overseer/docs/index.md"), "/rnm/overseer/docs/index.md");
  // The slash a URL pathname always carries is part of a POSIX path and never
  // part of a Windows one: kept, it is the path no Peon can find.
  assert.equal(
    localFilePath("file:///C:/Users/RNM/Projects/sales/deliverables/tender.html"),
    "C:/Users/RNM/Projects/sales/deliverables/tender.html",
  );
  assert.equal(localFilePath("file:///c:/work/a.html"), "c:/work/a.html");
  assert.equal(localFilePath("file:///C:/Users/RNM/a%20file.html"), "C:/Users/RNM/a file.html");
});

test("a plain path is taken as written, on either platform", () => {
  assert.equal(localFilePath("/rnm/overseer/README.md"), "/rnm/overseer/README.md");
  assert.equal(localFilePath("C:\\work\\site\\index.html"), "C:\\work\\site\\index.html");
  // A source position is how an agent cites a line, not part of the name.
  assert.equal(localFilePath("/repo/src/index.ts:312:4"), "/repo/src/index.ts");
  assert.equal(localFilePath("file:///C:/work/src/index.ts:312"), "C:/work/src/index.ts");
});

test("what is not a local file is not offered as one", () => {
  assert.equal(localFilePath(undefined), null);
  assert.equal(localFilePath("https://example.test/docs"), null);
  assert.equal(localFilePath("docs/index.md"), null);
  assert.equal(localFilePath("//host/share/a.txt"), null);
});
