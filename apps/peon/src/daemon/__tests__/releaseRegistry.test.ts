import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fetchLatestRelease, parsePeonRelease, releaseArchiveUrl, sha256File } from "../../shared/releaseRegistry.js";

const valid = {
  id: "release-123",
  version: "1.2.3",
  sha256: "a".repeat(64),
  sizeBytes: 42,
  createdAt: "2026-07-18T00:00:00.000Z",
};

test("release metadata is strict and supports version-addressed records", () => {
  assert.deepEqual(parsePeonRelease(valid), valid);
  assert.equal(parsePeonRelease({ ...valid, id: undefined }).id, "1.2.3");
  assert.throws(() => parsePeonRelease({ ...valid, sha256: "bad" }), /invalid sha256/);
  assert.throws(() => parsePeonRelease({ ...valid, sizeBytes: 0 }), /invalid sizeBytes/);
});

test("latest release uses Peon credentials and handles an empty registry", async () => {
  let seenHeaders: Headers | null = null;
  const fetchImpl: typeof fetch = async (_input, init) => {
    seenHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify({ code: "NO_RELEASES" }), { status: 404, headers: { "Content-Type": "application/json" } });
  };
  assert.equal(await fetchLatestRelease({ baseUrl: "https://overseer.example", token: "secret" }, fetchImpl), null);
  assert.equal(seenHeaders!.get("Authorization"), "Bearer secret");
  assert.equal(seenHeaders!.get("Peon-Protocol"), "1");
});

test("latest release rejects unrelated errors and validates successful metadata", async () => {
  const ok: typeof fetch = async () => new Response(JSON.stringify(valid), { status: 200, headers: { "Content-Type": "application/json" } });
  assert.deepEqual(await fetchLatestRelease({ baseUrl: "https://overseer.example", token: "secret" }, ok), valid);
  const productionEnvelope: typeof fetch = async () => new Response(JSON.stringify({
    release: {
      version: "0.2.0",
      size: 1_492_034,
      sha256: "b".repeat(64),
      createdAt: 1_784_613_768_312,
      archiveUrl: "/api/v1/releases/0.2.0/archive",
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  assert.deepEqual(await fetchLatestRelease({ baseUrl: "https://overseer.example", token: "secret" }, productionEnvelope), {
    id: "0.2.0",
    version: "0.2.0",
    sizeBytes: 1_492_034,
    sha256: "b".repeat(64),
    createdAt: "2026-07-21T06:02:48.312Z",
  });
  const missing: typeof fetch = async () => new Response(JSON.stringify({ code: "UNKNOWN" }), { status: 404, statusText: "Not Found" });
  await assert.rejects(fetchLatestRelease({ baseUrl: "https://overseer.example", token: "secret" }, missing), /404 Not Found/);
});

test("release archive URLs encode opaque release ids", () => {
  assert.equal(releaseArchiveUrl("https://overseer.example/base", { id: "v1/a" }).href, "https://overseer.example/api/v1/releases/v1%2Fa/archive");
});

test("sha256File hashes archive bytes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "peon-release-test-"));
  try {
    const file = path.join(dir, "archive.tgz");
    writeFileSync(file, "release bytes");
    assert.equal(await sha256File(file), createHash("sha256").update("release bytes").digest("hex"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
