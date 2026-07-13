import assert from "node:assert/strict";
import test from "node:test";
import { fileKindForName } from "./FileTypeIcon";

test("classifies common project file extensions case-insensitively", () => {
  assert.equal(fileKindForName("src/App.TSX"), "typescript");
  assert.equal(fileKindForName("public/logo.svg"), "image");
  assert.equal(fileKindForName("data/report.csv"), "data");
  assert.equal(fileKindForName("archive.tar.gz"), "archive");
});

test("recognizes common extensionless scripts and falls back safely", () => {
  assert.equal(fileKindForName("Dockerfile"), "shell");
  assert.equal(fileKindForName("README"), "unknown");
  assert.equal(fileKindForName("file.unknown"), "unknown");
});
