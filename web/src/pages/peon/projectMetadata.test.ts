import assert from "node:assert/strict";
import test from "node:test";
import type { Translate } from "../../i18n";
import { projectMarkdown } from "./PeonProjectDetail";

const labels: Record<string, string> = {
  "proj.key": "Project key",
  "proj.scope": "Scope",
  "newProject.dir": "Directory",
  "proj.metadata": "Metadata (Markdown)",
  "proj.notConfigured": "Not configured",
};
const t: Translate = (key) => labels[key] ?? key;

test("project detail renders migrated combined metadata as Markdown", () => {
  const metadata = "## Overview\n\nLegacy context\n\n## Bootstrap\n\n`npm install`\n\n## Release\n\nPublished";
  const rendered = projectMarkdown({ key: "demo", dir: "/work/demo", metadata }, "demo", t);

  assert.match(rendered, /## Metadata \(Markdown\)/);
  assert.ok(rendered.endsWith(metadata));
});

test("project detail renders a readable empty-metadata fallback", () => {
  const rendered = projectMarkdown({ key: "demo", dir: "/work/demo", metadata: null }, "demo", t);
  assert.ok(rendered.endsWith("_Not configured_"));
});
