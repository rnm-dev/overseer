import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.XDG_CONFIG_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-project-skills-config-"));
process.env.XDG_STATE_HOME = mkdtempSync(path.join(os.tmpdir(), "peon-project-skills-state-"));

const { settings } = await import("../settings/index.js");
const { projectStore } = await import("../projects/contracts.js");
const { createControlServer } = await import("../controlServer.js");

const token = "pn_project_skills_test";
settings.update({ overseerToken: token });

const projectDir = mkdtempSync(path.join(os.tmpdir(), "peon-project-skills-"));
const skillsDir = path.join(projectDir, ".agents", "skills");
mkdirSync(path.join(skillsDir, "release-package"), { recursive: true });
writeFileSync(path.join(skillsDir, "release-package", "SKILL.md"), `---
name: release-package
description: >
  Prepare and publish a package release.
---

# Release Package
`);
mkdirSync(path.join(skillsDir, "quoted-skill"), { recursive: true });
writeFileSync(path.join(skillsDir, "quoted-skill", "SKILL.md"), `---
name: "quoted-skill"
description: "A quoted description"
---
`);
mkdirSync(path.join(skillsDir, "invalid"), { recursive: true });
writeFileSync(path.join(skillsDir, "invalid", "SKILL.md"), "# Missing frontmatter\n");

const outside = mkdtempSync(path.join(os.tmpdir(), "peon-outside-skill-"));
writeFileSync(path.join(outside, "SKILL.md"), "---\nname: escaped-skill\ndescription: Must not leak\n---\n");
symlinkSync(outside, path.join(skillsDir, "escaped-skill"), "dir");

const project = projectStore.createProject({ key: "skill-api-project", label: "Skill API Project", dir: projectDir });
const server = createControlServer().listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}/api/v1`;

test.after(() => server.close());

const expected = {
  skills: [
    { name: "quoted-skill", description: "A quoted description", path: ".agents/skills/quoted-skill/SKILL.md", scope: "project" },
    { name: "release-package", description: "Prepare and publish a package release.", path: ".agents/skills/release-package/SKILL.md", scope: "project" },
  ],
};

test("project skills endpoint lists valid repository skills for human and fleet APIs", async () => {
  const human = await fetch(`${base}/projects/${project.key}/skills`);
  assert.equal(human.status, 200);
  assert.deepEqual(await human.json(), expected);

  const fleet = await fetch(`${base}/projects/${project.key}/skills`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(fleet.status, 200);
  assert.deepEqual(await fleet.json(), expected);
});

test("project skills endpoint returns the established unknown-project error", async () => {
  const human = await fetch(`${base}/projects/missing/skills`);
  assert.equal(human.status, 404);
  assert.deepEqual(await human.json(), { error: "unknown project", code: "UNKNOWN_PROJECT" });

  const fleet = await fetch(`${base}/projects/missing/skills`, {
    headers: { Authorization: `Bearer ${token}`, "Peon-Protocol": "1" },
  });
  assert.equal(fleet.status, 404);
  assert.deepEqual(await fleet.json(), { error: "unknown project", code: "UNKNOWN_PROJECT" });
});
