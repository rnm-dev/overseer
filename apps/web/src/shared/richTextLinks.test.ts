import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { localFilePath, relativeFilePath } from "./localFileLinks";
import { Markdown } from "./RichText";

const link = (source: string, props: Partial<Parameters<typeof Markdown>[0]> = {}) =>
  renderToStaticMarkup(createElement(Markdown, { source, ...props })).replace(/<\/?(?:div|p)[^>]*>/g, "");

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

test("a relative link names a file in the session's directory", () => {
  assert.equal(relativeFilePath("docs/spec.md"), "docs/spec.md");
  assert.equal(relativeFilePath("./report%20final.md#L4"), "report final.md");
  assert.equal(relativeFilePath("report.md:12"), "report.md");
  assert.equal(relativeFilePath("src/app.ts:12:4"), "src/app.ts");
  assert.equal(relativeFilePath("docs/../secret.md"), null);
  assert.equal(relativeFilePath("#heading"), null);
  assert.equal(relativeFilePath("example.com/pricing"), null);
  assert.equal(relativeFilePath("javascript:1"), null);
  assert.equal(relativeFilePath("mailto:ops@rnm.dev"), null);
});

// react-markdown empties any href whose scheme is not a web one before a
// component sees it, and an empty href opened in a new tab is the chat again.
test("every way an agent links a file reaches the file, not a new tab", () => {
  for (const [href, path] of [
    ["file:///home/peon/out/report.html", "/home/peon/out/report.html"],
    ["<file:///C:/work/a file.html>", "C:/work/a file.html"],
    ["C:/work/a.html", "C:/work/a.html"],
    ["/repo/report.md:12", "/repo/report.md"],
    ["report.md:12", "report.md"],
    ["docs/spec.md", "docs/spec.md"],
  ]) {
    const opened: string[] = [];
    const markup = link(`[x](${href})`, { onOpenFile: (p) => opened.push(p) });
    assert.doesNotMatch(markup, /target="_blank"/, href);
    assert.doesNotMatch(markup, /href=""/, href);
    assert.equal(localFilePath(href.replace(/^<|>$/g, "")) ?? relativeFilePath(href), path, href);
  }
});

test("an address the sanitizer refuses is shown as text, never opened", () => {
  assert.equal(link("[x](javascript:alert(1))", { onOpenFile: () => {} }), "<span>x</span>");
  assert.equal(link("[x](sandbox:/mnt/data/a.csv)", { onOpenFile: () => {} }), "<span>x</span>");
});

test("web links and fragments keep their ordinary behaviour", () => {
  assert.match(link("[x](https://example.com/a)", { onOpenFile: () => {} }), /href="https:\/\/example\.com\/a" target="_blank"/);
  assert.equal(link("[x](#notes)", { onOpenFile: () => {} }), '<a href="#notes">x</a>');
});
