import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ProjectDocsError,
  ProjectService,
  ProjectServiceError,
  ProjectStore,
} from "../projects/index.js";
import { projectCommandHandlers } from "../overseer/socket/channels/projectCommandHandlers.js";
import type { ValidCommand } from "../overseer/socket/channels/reverseCommandChannel.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "peon-project-reverse-"));
  const running = new Set<string>();
  const renamed: Array<[string, string]> = [];
  const service = new ProjectService(new ProjectStore(path.join(root, "projects.json")), {
    list: () => [...running].map((projectKey) => ({ projectKey, status: "running" })) as never,
    renameProjectKey: (oldKey, newKey) => { renamed.push([oldKey, newKey]); },
    start: () => { throw new Error("onboarding disabled in fixture"); },
    rename: () => false,
  });
  return { root, running, renamed, service };
}

test("project reverse service uses stable IDs and rejects stale rename/delete digests", () => {
  const f = fixture();
  try {
    const created = f.service.createRevisioned({ label: "Alpha", dir: path.join(f.root, "alpha") });
    const oldId = created.projectId;
    const renamed = f.service.updateSettingsById(oldId, { key: "beta" }, created.digest);
    assert.equal(renamed.projectId, oldId);
    assert.deepEqual(f.renamed, [["alpha", "beta"]]);
    assert.throws(
      () => f.service.updateSettingsById(oldId, { name: "stale" }, created.digest),
      (error) => error instanceof ProjectServiceError && error.kind === "PROJECT_CONFLICT",
    );
    assert.throws(
      () => f.service.removeById(oldId, created.digest),
      (error) => error instanceof ProjectServiceError && error.kind === "PROJECT_CONFLICT",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("key reuse cannot redirect a stable project ID and active sessions guard deletion", () => {
  const f = fixture();
  try {
    const original = f.service.createRevisioned({ label: "Alpha", dir: path.join(f.root, "one") });
    const renamed = f.service.updateSettingsById(original.projectId, { key: "old-alpha" }, original.digest);
    const replacement = f.service.createRevisioned({ label: "Alpha", dir: path.join(f.root, "two") });
    assert.notEqual(replacement.projectId, original.projectId);
    assert.equal(f.service.settingsById(original.projectId).key, "old-alpha");
    f.running.add("old-alpha");
    assert.throws(
      () => f.service.removeById(original.projectId, renamed.digest),
      (error) => error instanceof ProjectServiceError && error.kind === "PROJECT_RUNNING",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("project-ID resources preserve URL and documentation containment validation", () => {
  const f = fixture();
  try {
    const project = f.service.createRevisioned({ label: "Alpha", dir: path.join(f.root, "alpha") });
    assert.throws(
      () => f.service.createQuickLinkById(project.projectId, { title: "bad", url: "file:///etc/passwd" }, project.digest),
      (error) => error instanceof ProjectServiceError && error.kind === "BAD_REQUEST",
    );
    assert.throws(
      () => f.service.documentById(project.projectId, "../outside.md"),
      (error: { code?: string }) => error.code === "INVALID_PATH",
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("project command handlers preserve UTF-8 pagination and reject unsafe bounds", async () => {
  const f = fixture();
  try {
    const project = f.service.createRevisioned({ label: "Alpha", dir: path.join(f.root, "alpha") });
    const handlers = projectCommandHandlers(f.service);
    const handler = handlers["project.documentation.read"]!;
    const base: ValidCommand = {
      commandId: "00000000-0000-4000-8000-000000000001",
      operation: "project.documentation.read",
      target: {
        peonId: "00000000-0000-4000-8000-000000000002",
        projectId: project.projectId,
      },
      actor: {
        userId: "00000000-0000-4000-8000-000000000003",
        email: "operator@example.com",
      },
      payload: { path: "index.md", offset: 0, limit: 8 },
      expected: null,
      requestedAt: 1,
    };
    assert.equal(handler.validate(base.payload, null, base), null);
    assert.match(handler.validate({ path: "index.md", offset: -1 }, null, base) ?? "", /invalid/);
    assert.match(handler.validate({ path: "index.md", limit: 32 * 1024 + 1 }, null, base) ?? "", /invalid/);

    const first = await handler.execute(base);
    assert.equal(first.status, "applied");
    const result = first.result as { content: string; nextOffset: number | null };
    assert.equal(Buffer.byteLength(result.content), 8);
    assert.equal(result.nextOffset, 8);

    writeFileSync(path.join(f.root, "alpha", "docs", "index.md"), "éclair");
    const split = await handler.execute({
      ...base,
      payload: { path: "index.md", offset: 1, limit: 3 },
    });
    assert.equal(split.status, "applied");
    assert.deepEqual(split.result && {
      content: split.result.content,
      offset: split.result.offset,
      nextOffset: split.result.nextOffset,
    }, { content: "cla", offset: 2, nextOffset: 5 });

    const update = handlers["project.settings.update"]!;
    assert.match(update.validate(
      { name: "Changed" },
      { digest: "not-a-canonical-digest" },
      { ...base, operation: "project.settings.update", payload: { name: "Changed" } },
    ) ?? "", /invalid/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("project documentation internal failures are terminal failures, not user rejections", async () => {
  const f = fixture();
  try {
    const project = f.service.createRevisioned({ label: "Alpha", dir: path.join(f.root, "alpha") });
    const failing = Object.create(f.service) as ProjectService;
    failing.documentById = () => {
      throw new ProjectDocsError(500, "INTERNAL", "sensitive local failure");
    };
    const handler = projectCommandHandlers(failing)["project.documentation.read"]!;
    const execution = await handler.execute({
      commandId: "00000000-0000-4000-8000-000000000001",
      operation: "project.documentation.read",
      target: {
        peonId: "00000000-0000-4000-8000-000000000002",
        projectId: project.projectId,
      },
      actor: {
        userId: "00000000-0000-4000-8000-000000000003",
        email: "operator@example.com",
      },
      payload: { path: "index.md" },
      expected: null,
      requestedAt: 1,
    });
    assert.deepEqual(execution, { status: "failed", code: "INTERNAL" });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("project documentation index pages oversized snapshots with stable cursor identity", async () => {
  const f = fixture();
  try {
    const project = f.service.createRevisioned({ label: "Alpha", dir: path.join(f.root, "alpha") });
    const docs = path.join(f.root, "alpha", "docs");
    for (let index = 0; index < 800; index += 1) {
      writeFileSync(path.join(docs, `document-${String(index).padStart(4, "0")}.md`), `# Document ${index}\n`);
    }
    const handler = projectCommandHandlers(f.service)["project.documentation.index"]!;
    const base: ValidCommand = {
      commandId: "00000000-0000-4000-8000-000000000011",
      operation: "project.documentation.index",
      target: {
        peonId: "00000000-0000-4000-8000-000000000012",
        projectId: project.projectId,
      },
      actor: {
        userId: "00000000-0000-4000-8000-000000000013",
        email: "operator@example.com",
      },
      payload: { limit: 1024 },
      expected: null,
      requestedAt: 1,
    };
    assert.deepEqual(await handler.execute(base), await handler.execute(base));
    const chunks: string[] = [];
    let cursor: string | null = null;
    let firstNextCursor: string | null = null;
    do {
      const page = await handler.execute({
        ...base,
        payload: { limit: 1024, ...(cursor ? { cursor } : {}) },
      });
      assert.equal(page.status, "applied");
      const detail = page.result as { chunk: string; nextCursor: string | null; totalBytes: number };
      assert.ok(detail.totalBytes > 48 * 1024);
      chunks.push(detail.chunk);
      firstNextCursor ??= detail.nextCursor;
      cursor = detail.nextCursor;
    } while (cursor);
    const snapshot = JSON.parse(chunks.join("")) as { tree: unknown[] };
    assert.equal(snapshot.tree.length, 801);

    const tampered = `${firstNextCursor!.slice(0, -1)}${firstNextCursor!.endsWith("A") ? "B" : "A"}`;
    assert.deepEqual(await handler.execute({ ...base, payload: { cursor: tampered, limit: 1024 } }), {
      status: "rejected",
      code: "INVALID_CURSOR",
    });

    writeFileSync(path.join(docs, "changed.md"), "# Changed\n");
    assert.deepEqual(await handler.execute({ ...base, payload: { cursor: firstNextCursor!, limit: 1024 } }), {
      status: "conflict",
      code: "CURSOR_EXPIRED",
    });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
