import assert from "node:assert/strict";
import test from "node:test";
import { fileMenuItemCount } from "./ProjectFiles";
import { collectDroppedFiles, filesFromInput, pendingRows, readDraggedEntry, safeSegment, takeDroppedEntries } from "./fileTransfers";

const fileEntry = (name: string) => ({
  name,
  isFile: true,
  isDirectory: false,
  file: (ok: (file: File) => void) => ok(new File(["x"], name)),
});

// `readEntries` hands back one page at a time and ends with an empty page.
const directoryEntry = (name: string, children: unknown[], pageSize = 1) => ({
  name,
  isFile: false,
  isDirectory: true,
  createReader: () => {
    let cursor = 0;
    return {
      readEntries: (ok: (entries: unknown[]) => void) => {
        const page = children.slice(cursor, cursor + pageSize);
        cursor += page.length;
        ok(page);
      },
    };
  },
});

const transfer = (items: unknown[], files: File[] = []) => ({
  items: items.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
  files,
}) as unknown as DataTransfer;

test("a plain file drop keeps its name and no folder prefix", async () => {
  const dropped = await collectDroppedFiles(takeDroppedEntries(transfer([fileEntry("notes.md")])));
  assert.deepEqual(dropped.map((item) => item.relativePath), ["notes.md"]);
});

test("a dropped folder becomes relative paths, across readEntries pages", async () => {
  const tree = directoryEntry("docs", [
    fileEntry("index.md"),
    directoryEntry("api", [fileEntry("files.md")]),
    fileEntry("readme.md"),
  ]);
  const dropped = await collectDroppedFiles(takeDroppedEntries(transfer([tree])));
  assert.deepEqual(dropped.map((item) => item.relativePath).sort(), [
    "docs/api/files.md",
    "docs/index.md",
    "docs/readme.md",
  ]);
});

test("a name from the operator's filesystem cannot escape the drop target", async () => {
  assert.equal(safeSegment("../../etc/passwd"), ".._.._etc_passwd");
  assert.equal(safeSegment(".."), "file");
  assert.equal(safeSegment(""), "file");
  const dropped = await collectDroppedFiles(takeDroppedEntries(transfer([directoryEntry("..", [fileEntry("a/b")])])));
  assert.deepEqual(dropped.map((item) => item.relativePath), ["file/a_b"]);
});

test("a browser without entry support falls back to the flat file list", async () => {
  const files = [new File(["x"], "one.txt"), new File(["y"], "two.txt")];
  const dropped = await collectDroppedFiles(takeDroppedEntries(transfer([null, null], files)));
  assert.deepEqual(dropped.map((item) => item.relativePath), ["one.txt", "two.txt"]);
});

test("a dragged tree entry survives the round trip and rejects junk", () => {
  const read = (raw: string) => readDraggedEntry({ getData: () => raw } as unknown as DataTransfer);
  assert.deepEqual(read(JSON.stringify({ path: "docs/api", type: "dir" })), { path: "docs/api", type: "dir", size: undefined });
  assert.deepEqual(read(JSON.stringify({ path: "a.txt", size: 12 })), { path: "a.txt", type: "file", size: 12 });
  assert.equal(read("not json"), null);
  assert.equal(read(JSON.stringify({ type: "dir" })), null);
  assert.equal(read(""), null);
});

test("a picked folder keeps its tree, a picked file keeps its name", () => {
  const picked = (name: string, relative?: string) => Object.assign(new File(["x"], name), { webkitRelativePath: relative ?? "" });
  assert.deepEqual(filesFromInput([
    picked("notes.md"),
    picked("files.md", "docs/api/files.md"),
    picked("evil.txt", "../../etc/evil.txt"),
  ] as unknown as FileList).map((item) => item.relativePath), [
    "notes.md",
    "docs/api/files.md",
    "file/file/etc/evil.txt",
  ]);
  assert.deepEqual(filesFromInput(null), []);
});

test("a context menu that would be empty is not offered", () => {
  // file: open, download, copy path — the root: uploads only, no path to copy.
  assert.equal(fileMenuItemCount("file", "src/a.ts", false), 3);
  // Delete joins a file's menu only where the tree may write.
  assert.equal(fileMenuItemCount("file", "src/a.ts", true), 4);
  // A folder always offers refresh, then uploads and its path where they apply.
  assert.equal(fileMenuItemCount("dir", "src", true), 4);
  assert.equal(fileMenuItemCount("dir", "", true), 3);
  assert.equal(fileMenuItemCount("dir", "src", false), 2);
  assert.equal(fileMenuItemCount("dir", "", false), 1);
});

test("a drop becomes one placeholder row per immediate child, carrying its bytes", () => {
  const dropped = (relativePath: string, size: number) => ({ file: { size } as File, relativePath });
  const rows = pendingRows("src", [
    dropped("notes.md", 10),
    dropped("docs/index.md", 20),
    dropped("docs/api/files.md", 30),
  ]);
  assert.deepEqual(rows, [
    { parent: "src", name: "notes.md", type: "file", total: 10, sent: 0 },
    { parent: "src", name: "docs", type: "dir", total: 50, sent: 0 },
  ]);
  // A single nested file still names the folder it arrives in, not the file.
  assert.deepEqual(pendingRows("", [dropped("docs/only.md", 5)]), [
    { parent: "", name: "docs", type: "dir", total: 5, sent: 0 },
  ]);
});
