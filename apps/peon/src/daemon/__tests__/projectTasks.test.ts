import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectTask, disableProjectTasks, enableProjectTasks, moveProjectTask, projectTaskBoard, updateProjectTask } from "../projects/tasks.js";
import { buildSystemPrompt } from "../sessions/sessionPrompts.js";

function project(): string {
  return mkdtempSync(path.join(tmpdir(), "peon-tasks-"));
}

const tasksDir = (dir: string) => path.join(dir, "docs", "tasks");

test("a project without config.yml is not opted in, even if docs/tasks exists", () => {
  const dir = project();
  mkdirSync(path.join(tasksDir(dir), "todo"), { recursive: true });
  writeFileSync(path.join(tasksDir(dir), "todo", "T-1-a.md"), "---\nid: T-1\ntitle: A\n---\n");
  assert.deepEqual(projectTaskBoard(dir), {
    enabled: false, statuses: ["todo", "in-progress", "review", "done"], tasks: [], problems: [],
  });
});

test("setup writes config, README and kept status folders, and refuses twice", () => {
  const dir = project();
  const board = enableProjectTasks(dir);
  assert.equal(board.enabled, true);
  for (const status of ["todo", "in-progress", "review", "done"]) {
    assert.equal(existsSync(path.join(tasksDir(dir), status, ".gitkeep")), true);
  }
  assert.match(readFileSync(path.join(tasksDir(dir), "config.yml"), "utf8"), /statuses:\n {2}- todo\n {2}- in-progress\n {2}- review\n {2}- done\n/);
  assert.match(readFileSync(path.join(tasksDir(dir), "README.md"), "utf8"), /Status is the folder/);
  assert.throws(() => enableProjectTasks(dir), { code: "TASKS_ALREADY_ENABLED" });
});

test("setup keeps a README the project already wrote", () => {
  const dir = project();
  mkdirSync(tasksDir(dir), { recursive: true });
  writeFileSync(path.join(tasksDir(dir), "README.md"), "our rules\n");
  enableProjectTasks(dir);
  assert.equal(readFileSync(path.join(tasksDir(dir), "README.md"), "utf8"), "our rules\n");
});

test("turning tasks off removes only config.yml", () => {
  const dir = project();
  enableProjectTasks(dir);
  writeFileSync(path.join(tasksDir(dir), "todo", "T-1-a.md"), "---\nid: T-1\ntitle: A\n---\n");
  assert.equal(disableProjectTasks(dir).enabled, false);
  assert.equal(existsSync(path.join(tasksDir(dir), "todo", "T-1-a.md")), true);
  assert.equal(existsSync(path.join(tasksDir(dir), "README.md")), true);
  assert.throws(() => disableProjectTasks(dir), { code: "TASKS_NOT_ENABLED" });
});

test("the board reads the folder as status; unknown folders, duplicates and bad files are reported", () => {
  const dir = project();
  const tasks = tasksDir(dir);
  for (const folder of ["backlog", "doing", "archive"]) mkdirSync(path.join(tasks, folder), { recursive: true });
  writeFileSync(path.join(tasks, "config.yml"), "statuses:\n  - backlog\n  - doing\n");
  writeFileSync(path.join(tasks, "backlog", "T-3-a.md"), "---\nid: T-3\ntitle: A\nassignee: a@b.c\nsessions: [p/s1]\npriority: high\n---\n\nBody\n");
  writeFileSync(path.join(tasks, "doing", "T-3-b.md"), "---\nid: T-3\ntitle: B\n---\n");
  writeFileSync(path.join(tasks, "archive", "T-9-old.md"), "---\nid: T-9\ntitle: Old\n---\n");
  writeFileSync(path.join(tasks, "doing", "notes.md"), "no front matter");
  const board = projectTaskBoard(dir);
  assert.deepEqual(board.statuses, ["backlog", "doing"]);
  assert.deepEqual(board.tasks.map(({ digest: _digest, ...task }) => task), [{
    id: "T-3", title: "A", status: "backlog", path: "tasks/backlog/T-3-a.md", assignee: "a@b.c",
    sessions: ["p/s1"], created: null, updated: null, body: "Body",
  }]);
  assert.deepEqual(board.problems.map((p) => p.reason), ["UNKNOWN_STATUS", "INVALID_FILE", "DUPLICATE_ID"]);
  renameSync(path.join(tasks, "doing", "T-3-b.md"), path.join(tasks, "doing", "T-4-b.md"));
  writeFileSync(path.join(tasks, "doing", "T-4-b.md"), "---\nid: T-4\ntitle: B\n---\n");
  assert.deepEqual(projectTaskBoard(dir).tasks.map((t) => [t.id, t.status]), [["T-3", "backlog"], ["T-4", "doing"]]);
});

test("only opted-in projects get the two-line pointer in the session prompt", () => {
  const dir = project();
  const record = { projectId: "p", key: "p", label: "P", dir, lastSyncedAt: 1 };
  assert.doesNotMatch(buildSystemPrompt(false, [], "/tmp/previews", record), /docs\/tasks/);
  enableProjectTasks(dir);
  assert.match(buildSystemPrompt(false, [], "/tmp/previews", record), /tracks tasks as files in docs\/tasks\/\. Read docs\/tasks\/README\.md/);
});

test("the write API refuses until the project opted in", () => {
  const dir = project();
  assert.throws(() => createProjectTask(dir, { title: "Too early" }), { code: "TASKS_NOT_ENABLED" });
});

test("create allocates the next id across all folders and writes no status field", () => {
  const dir = project();
  enableProjectTasks(dir);
  writeFileSync(path.join(tasksDir(dir), "done", "T-7-old.md"), "---\nid: T-7\ntitle: Old\n---\n");
  const task = createProjectTask(dir, { title: "File-based tasks", assignee: "a@b.c", body: "Do it." }, new Date("2026-11-18T10:00:00Z"));
  assert.equal(task.id, "T-8");
  assert.equal(task.path, "tasks/todo/T-8-file-based-tasks.md");
  assert.equal(
    readFileSync(path.join(dir, "docs", task.path), "utf8"),
    "---\nid: T-8\ntitle: File-based tasks\nassignee: a@b.c\ncreated: 2026-11-18\nupdated: 2026-11-18\n---\n\nDo it.\n",
  );
  assert.throws(() => createProjectTask(dir, { title: "x", status: "nope" }), { code: "UNKNOWN_STATUS" });
  assert.throws(() => createProjectTask(dir, { title: "two\nlines" }), { code: "INVALID_TASK" });
});

test("move renames into the target folder and is fenced by digest", () => {
  const dir = project();
  enableProjectTasks(dir);
  const task = createProjectTask(dir, { title: "Move me" });
  assert.throws(() => moveProjectTask(dir, task.id, { status: "done", digest: "stale" }), { code: "TASK_CONFLICT" });
  assert.throws(() => moveProjectTask(dir, "T-99", { status: "done", digest: task.digest }), { code: "TASK_NOT_FOUND" });
  const moved = moveProjectTask(dir, task.id, { status: "done", digest: task.digest });
  assert.equal(moved.path, "tasks/done/T-1-move-me.md");
  assert.equal(moved.digest, task.digest);
  assert.equal(existsSync(path.join(dir, "docs", task.path)), false);
});

test("update rewrites known fields and keeps keys the API does not know", () => {
  const dir = project();
  enableProjectTasks(dir);
  const file = path.join(tasksDir(dir), "todo", "T-1-x.md");
  writeFileSync(file, "---\nid: T-1\ntitle: X\npriority: high\nlabels: [ui, web]\n---\n\nBody\n");
  const [task] = projectTaskBoard(dir).tasks;
  const updated = updateProjectTask(dir, "T-1", { digest: task.digest, title: "Renamed: X", sessions: ["p/s1"] }, new Date("2026-11-18T00:00:00Z"));
  assert.equal(updated.title, "Renamed: X");
  assert.deepEqual(updated.sessions, ["p/s1"]);
  const source = readFileSync(file, "utf8");
  assert.match(source, /priority: high\nlabels: \[ui, web\]/);
  assert.match(source, /\n\nBody\n$/);
  assert.throws(() => updateProjectTask(dir, "T-1", { digest: task.digest, title: "again" }), { code: "TASK_CONFLICT" });
});

// Regressions from the OVSR-616 review.

test("quotes and backslashes in a title survive any number of edits", () => {
  const dir = project();
  enableProjectTasks(dir);
  const title = 'Fix "login" bug \\ path: C:\\temp';
  let task = createProjectTask(dir, { title });
  assert.equal(task.title, title);
  for (let i = 0; i < 3; i += 1) {
    task = updateProjectTask(dir, task.id, { digest: task.digest, body: `edit ${i}` });
    assert.equal(projectTaskBoard(dir).tasks[0].title, title);
  }
});

test("the next id follows front matter ids, not only file names", () => {
  const dir = project();
  enableProjectTasks(dir);
  writeFileSync(path.join(tasksDir(dir), "todo", "login-fix.md"), "---\nid: T-50\ntitle: Login\n---\n");
  assert.equal(createProjectTask(dir, { title: "Next" }).id, "T-51");
});

test("an id used only by a rejected file is never handed out again", () => {
  const dir = project();
  enableProjectTasks(dir);
  mkdirSync(path.join(tasksDir(dir), "archive"));
  writeFileSync(path.join(tasksDir(dir), "archive", "old.md"), "---\nid: T-9\ntitle: Old\n---\n");
  assert.equal(createProjectTask(dir, { title: "Next" }).id, "T-10");
});

test("turning tasks off and on again keeps the project's own statuses", () => {
  const dir = project();
  enableProjectTasks(dir);
  const tasks = tasksDir(dir);
  writeFileSync(path.join(tasks, "config.yml"), "statuses: [backlog, doing, done]\n");
  for (const status of ["backlog", "doing"]) mkdirSync(path.join(tasks, status), { recursive: true });
  writeFileSync(path.join(tasks, "doing", "T-1-a.md"), "---\nid: T-1\ntitle: A\n---\n");
  disableProjectTasks(dir);
  assert.equal(existsSync(path.join(tasks, "config.yml")), false);
  const board = enableProjectTasks(dir);
  assert.deepEqual(board.statuses, ["backlog", "doing", "done"]);
  assert.deepEqual(board.tasks.map((t) => t.status), ["doing"]);
});

test("setup after config.yml was deleted by hand infers statuses from the folders", () => {
  const dir = project();
  const tasks = tasksDir(dir);
  for (const status of ["doing", "done", "backlog", "todo"]) mkdirSync(path.join(tasks, status), { recursive: true });
  assert.deepEqual(enableProjectTasks(dir).statuses, ["todo", "done", "backlog", "doing"]);
  assert.equal(existsSync(path.join(tasks, "in-progress")), false);
});

test("docs/tasks resolving outside the project is refused for setup and invisible to the board", () => {
  const dir = project();
  const outside = project();
  mkdirSync(path.join(dir, "docs"));
  symlinkSync(outside, path.join(dir, "docs", "tasks"));
  assert.throws(() => enableProjectTasks(dir), { code: "PATH_ESCAPE" });
  assert.deepEqual(readdirSync(outside), []);
  assert.equal(projectTaskBoard(dir).enabled, false);
});

test("writes never follow a symlinked status folder", () => {
  const dir = project();
  const outside = project();
  enableProjectTasks(dir);
  const tasks = tasksDir(dir);
  writeFileSync(path.join(tasks, "config.yml"), "statuses: [todo, escape]\n");
  symlinkSync(outside, path.join(tasks, "escape"));
  assert.throws(() => createProjectTask(dir, { title: "Out", status: "escape" }), { code: "PATH_ESCAPE" });
  const task = createProjectTask(dir, { title: "In" });
  assert.throws(() => moveProjectTask(dir, task.id, { status: "escape", digest: task.digest }), { code: "PATH_ESCAPE" });
  assert.deepEqual(readdirSync(outside), []);
});

test("an edit never merges in a change made after the caller read the task", () => {
  const dir = project();
  enableProjectTasks(dir);
  const task = createProjectTask(dir, { title: "Race" });
  const file = path.join(dir, "docs", task.path);
  writeFileSync(file, readFileSync(file, "utf8").replace("title: Race", "title: Race\npriority: high"));
  assert.throws(() => updateProjectTask(dir, task.id, { digest: task.digest, title: "Mine" }), { code: "TASK_CONFLICT" });
  assert.match(readFileSync(file, "utf8"), /priority: high/);
  assert.equal(readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp")), false);
});

test("quoted list items keep their commas across an edit", () => {
  const dir = project();
  enableProjectTasks(dir);
  const file = path.join(tasksDir(dir), "todo", "T-1-x.md");
  writeFileSync(file, '---\nid: T-1\ntitle: X\nlabels: ["ui, web", api]\n---\n');
  const [task] = projectTaskBoard(dir).tasks;
  updateProjectTask(dir, "T-1", { digest: task.digest, body: "b" });
  assert.match(readFileSync(file, "utf8"), /labels: \["ui, web", api\]/);
});

test("a task without a title is reported, not given its id as a title", () => {
  const dir = project();
  enableProjectTasks(dir);
  writeFileSync(path.join(tasksDir(dir), "todo", "T-3-x.md"), "---\nid: T-3\n---\n");
  const board = projectTaskBoard(dir);
  assert.deepEqual(board.tasks, []);
  assert.deepEqual(board.problems.map((p) => p.reason), ["INVALID_FILE"]);
});

test("non-Latin titles keep a readable file name", () => {
  const dir = project();
  enableProjectTasks(dir);
  assert.equal(createProjectTask(dir, { title: "Исправить вход!" }).path, "tasks/todo/T-1-исправить-вход.md");
});
