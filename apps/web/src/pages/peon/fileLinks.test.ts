import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentUploadPath,
  fileApiPath,
  fileKind,
  fileUrl,
  projectDirectoryListingPath,
} from "./fileLinks";

const base = "/workspaces/ws/peons/nova";

test("every file source names the route that answers for it", () => {
  // An attachment travels as the Peon's absolute path for every message the
  // client did not just send; mounting it under /files would ask for
  // `/files//tmp/...`, and the proxies in front of Overseer merge that double
  // slash away before the route ever sees it.
  assert.equal(
    fileApiPath({ kind: "attachment", base, path: "/tmp/peon-files/uploads/s/pasted-1785321100386-0.png" }),
    `${base}/attachments?path=%2Ftmp%2Fpeon-files%2Fuploads%2Fs%2Fpasted-1785321100386-0.png`,
  );
  assert.equal(fileApiPath({ kind: "attachment", base, path: "uploads/s/a.png" }), `${base}/attachments?path=uploads%2Fs%2Fa.png`);
  assert.equal(fileApiPath({ kind: "project", base, projectKey: "OVSR", path: "src/a b.ts" }), `${base}/projects/OVSR/files/src/a%20b.ts`);
  assert.equal(fileApiPath({ kind: "projectById", base, projectId: "project/id", path: "docs/index.md" }), `${base}/projects/by-id/project%2Fid/files/docs/index.md`);
  assert.equal(fileApiPath({ kind: "sessionFile", base, sessionId: "s 1", path: "out/report.html" }), `${base}/sessions/s%201/file?path=out%2Freport.html`);
  assert.equal(fileApiPath({ kind: "sessionFile", base, sessionId: "s1", path: "out/report.html", raw: true }), `${base}/sessions/s1/file/raw?path=out%2Freport.html`);
  assert.equal(attachmentUploadPath(base, "session id", "notes.md"), `${base}/files/uploads/session%20id/notes.md`);
  assert.equal(fileUrl({ kind: "attachment", base, path: "a.png" }), `/api${base}/attachments?path=a.png`);
  assert.equal(
    projectDirectoryListingPath(`${base}/projects/OVSR/files`, "src/a b"),
    `${base}/projects/OVSR/files/src/a%20b?stat=1&directory=1`,
  );
  assert.equal(
    projectDirectoryListingPath(`${base}/projects/OVSR/files`, ""),
    `${base}/projects/OVSR/files/?stat=1&directory=1`,
  );
});

test("the sandbox serves uploads as octet-stream, so name and sender hint decide the display", () => {
  assert.equal(fileKind({ name: "pasted-123-0.png", contentType: "application/octet-stream" }), "image");
  assert.equal(fileKind({ name: "upload", contentType: "application/octet-stream", hint: "image" }), "image");
  assert.equal(fileKind({ name: "upload", contentType: "image/webp" }), "image");
  assert.equal(fileKind({ name: "upload", contentType: "application/pdf; charset=binary" }), "pdf");
  assert.equal(fileKind({ name: "notes.md", contentType: "application/octet-stream" }), "markdown");
  assert.equal(fileKind({ name: "server.ts", contentType: "application/octet-stream" }), "text");
});

test("an unknown type reads as text in a project tree and as unsupported as an attachment", () => {
  // A project tree is full of extensionless text; an attachment of unknown
  // binary type says so rather than rendering bytes as characters.
  assert.equal(fileKind({ name: "Dockerfile", contentType: "application/octet-stream", fallback: "text" }), "text");
  assert.equal(fileKind({ name: "Dockerfile", contentType: "application/octet-stream" }), "unsupported");
  assert.equal(fileKind({ name: "archive.zip", contentType: "application/octet-stream" }), "unsupported");
});
