import assert from "node:assert/strict";
import { test } from "node:test";
import { projectFileProxyQuery } from "../modules/projects/projectFileHttp.js";
import { demoFileResponse, isDemoDirectory } from "./screenshotDemoFiles.js";

// The Files tab showed a bare "Retry" against the demo Peon, and the reason was
// a contract mismatch nothing tested: the client asks with `stat=1&directory=1`,
// Overseer strips its own private `directory` hint before proxying, and the demo
// Peon keyed its listing off exactly that stripped parameter. It answered a
// listing request with a markdown body, so the client parsed a string where it
// wanted `entries`.
//
// The first test is the regression proper — it starts from the URL the client
// really sends and puts it through the real strip, rather than assuming what
// arrives.

/** What a Peon actually receives for a client's directory request. */
function statAsProxied(clientUrl: string): string | null {
  return new URLSearchParams(projectFileProxyQuery(clientUrl)).get("stat");
}

test("the query Overseer proxies for a browse still reaches the demo Peon as a listing", () => {
  const proxied = projectFileProxyQuery("/api/workspaces/w/peons/p/projects/mobile-app/files/?stat=1&directory=1");
  // The hint is Overseer-private and does not survive the hop.
  assert.equal(proxied.includes("directory"), false);
  assert.equal(statAsProxied("/api/workspaces/w/peons/p/projects/mobile-app/files/?stat=1&directory=1"), "1");

  const answer = demoFileResponse("", statAsProxied("/x?stat=1&directory=1"));
  assert.equal(answer.kind, "stat");
  assert.equal(answer.body.type, "directory");
  assert.ok(answer.body.type === "directory" && answer.body.entries.length > 0);
});

test("a directory stat lists entries the client can render", () => {
  const answer = demoFileResponse("", "1");
  assert.equal(answer.kind, "stat");
  assert.ok(answer.body.type === "directory");
  if (answer.body.type !== "directory") return;
  assert.deepEqual(
    answer.body.entries.map((e) => e.name).sort(),
    ["README.md", "docs", "lib", "pubspec.yaml"],
  );
  // Every entry carries the two fields the client requires; anything else is
  // optional to it.
  for (const entry of answer.body.entries) {
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.type === "file" || entry.type === "directory");
  }
});

test("nested directories list, and a leading or trailing slash is not a different path", () => {
  for (const path of ["docs", "/docs", "docs/", "/docs/"]) {
    const answer = demoFileResponse(path, "1");
    assert.equal(answer.kind, "stat", path);
    if (answer.kind !== "stat") return;
    assert.equal(answer.body.type, "directory", path);
  }
  const widgets = demoFileResponse("lib/widgets", "1");
  assert.equal(widgets.kind, "stat");
  if (widgets.kind !== "stat") return;
  assert.ok(widgets.body.type === "directory" && widgets.body.entries[0].name === "session_card.dart");
});

test("a file stat describes the file rather than listing it", () => {
  const answer = demoFileResponse("README.md", "1");
  assert.equal(answer.kind, "stat");
  assert.equal(answer.body.type, "file");
  if (answer.body.type !== "file") return;
  assert.ok(answer.body.size > 0);
  assert.equal(answer.body.sha256.length, 64);
});

// The half that must not regress while fixing the other: a download is still a
// download.
test("a request without stat still returns the file body", () => {
  const answer = demoFileResponse("README.md", null);
  assert.equal(answer.kind, "content");
  if (answer.kind !== "content") return;
  assert.match(answer.body, /^# Mobile App/);
  assert.match(answer.contentType, /^text\/markdown/);
});

// The real Peon reads `stat` as present-or-absent rather than comparing it to
// "1", so a client that sends stat=0 is still asking for metadata.
test("stat is read as present, not as equal to one", () => {
  assert.equal(demoFileResponse("", "0").kind, "stat");
  assert.equal(demoFileResponse("", "").kind, "stat");
});

test("the demo tree knows which of its paths are directories", () => {
  assert.equal(isDemoDirectory(""), true);
  assert.equal(isDemoDirectory("lib/widgets"), true);
  assert.equal(isDemoDirectory("README.md"), false);
});
