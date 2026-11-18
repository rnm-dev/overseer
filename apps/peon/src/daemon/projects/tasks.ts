import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import path from "node:path";
import { Document, isSeq, parse as parseYaml, parseDocument } from "yaml";
import { PROJECT_DOCS_DIR } from "./docs.js";

// Project task files: one Markdown file per task under docs/tasks/<status>/,
// metadata in YAML front matter. The folder is the status; there is no status
// field. Agents mostly edit the files directly; the write API below is for
// machine callers and only works once the project opted in. The web board is
// read-only. See docs/project-task-files.md.
//
// Every function here is synchronous, so two API calls never interleave inside
// one; the races left are with agents editing the same files, and those are
// reported (DUPLICATE_ID, TASK_CONFLICT) rather than prevented.

export const PROJECT_TASKS_DIR = "tasks";
export const PROJECT_TASKS_CONFIG = "config.yml";
// Turning tasks off through the API parks the config here, so turning them
// back on restores the project's own statuses instead of the defaults.
export const PROJECT_TASKS_PARKED_CONFIG = ".config.yml.off";
export const PROJECT_TASKS_README = "README.md";
export const DEFAULT_TASK_STATUSES = ["todo", "in-progress", "review", "done"] as const;
const MAX_TASKS = 2_000;
const MAX_TASK_BYTES = 256 * 1024;
const STATUS_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ID_PATTERN = /^T-([1-9]\d{0,8})$/;
const MAX_TITLE_LENGTH = 200;
const MAX_BODY_LENGTH = 64 * 1024;
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;

export interface ProjectTask {
  id: string;
  title: string;
  status: string;
  path: string;
  assignee: string | null;
  sessions: string[];
  created: string | null;
  updated: string | null;
  body: string;
  // Fences writes: an edit or move must carry the digest of the file it read.
  digest: string;
}

export interface ProjectTaskProblem {
  path: string;
  reason: "UNKNOWN_STATUS" | "DUPLICATE_ID" | "INVALID_FILE";
  id?: string;
}

export interface ProjectTaskBoard {
  // docs/tasks/config.yml exists: the project opted in. Without it the board
  // is empty and agents are told nothing about task files.
  enabled: boolean;
  statuses: string[];
  tasks: ProjectTask[];
  problems: ProjectTaskProblem[];
}

export class ProjectTasksError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | "TASKS_ALREADY_ENABLED"
      | "TASKS_NOT_ENABLED"
      | "INVALID_TASK"
      | "UNKNOWN_STATUS"
      | "TASK_NOT_FOUND"
      | "TASK_CONFLICT"
      | "TOO_MANY_TASKS"
      | "PATH_ESCAPE",
    message: string,
  ) {
    super(message);
  }
}

export function parseFrontMatter(source: string): { meta: Record<string, unknown>; body: string } | null {
  const match = source.match(FRONT_MATTER);
  if (!match) return null;
  let meta: unknown;
  try {
    // The core schema keeps `2026-11-18` a string instead of a Date.
    meta = parseYaml(match[1], { schema: "core" }) ?? {};
  } catch {
    return null;
  }
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  return { meta: meta as Record<string, unknown>, body: source.slice(match[0].length) };
}

function digestOf(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 32);
}

function slugify(title: string): string {
  const slug = title.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/[\s_-]+/g, "-");
  return [...slug].slice(0, 60).join("").replace(/-+$/, "") || "task";
}

function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

// docs/ and docs/tasks/ may be real directories or symlinks that stay inside
// the project; anything resolving outside it is refused, as docs.ts does.
function tasksDir(projectDir: string): string {
  const realProject = realpathSync(projectDir);
  const docs = path.join(realProject, PROJECT_DOCS_DIR);
  const dir = path.join(docs, PROJECT_TASKS_DIR);
  for (const candidate of [docs, dir]) {
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!isInside(realProject, real)) {
      throw new ProjectTasksError(400, "PATH_ESCAPE", "docs/tasks resolves outside the project");
    }
  }
  return dir;
}

// Writes never follow a symlinked status folder or task file.
function requireRealDirectory(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) throw new ProjectTasksError(400, "PATH_ESCAPE", "status folder is not a plain directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      mkdirSync(dir);
      return;
    }
    throw error;
  }
}

// Write to a sibling temp file and rename over the target, so a crash never
// leaves a half-written task behind.
function writeAtomic(target: string, content: string): void {
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.tmp`);
  writeFileSync(temp, content, { flag: "w" });
  renameSync(temp, target);
}

function statusesFrom(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const statuses = [...new Set(raw.filter((s): s is string => typeof s === "string").map((s) => s.trim()).filter((s) => STATUS_PATTERN.test(s)))];
  return statuses.length ? statuses : null;
}

function readStatuses(dir: string): string[] {
  try {
    const config = parseYaml(readFileSync(path.join(dir, PROJECT_TASKS_CONFIG), "utf8"), { schema: "core" }) as { statuses?: unknown } | null;
    return statusesFrom(config?.statuses) ?? [...DEFAULT_TASK_STATUSES];
  } catch {
    return [...DEFAULT_TASK_STATUSES];
  }
}

function stringField(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readTask(content: string, relPath: string, status: string): ProjectTask | null {
  const parsed = parseFrontMatter(content);
  if (!parsed) return null;
  const id = stringField(parsed.meta, "id");
  const title = stringField(parsed.meta, "title");
  if (!id || !ID_PATTERN.test(id) || !title) return null;
  const sessions = parsed.meta.sessions;
  return {
    id,
    title,
    status,
    path: relPath,
    assignee: stringField(parsed.meta, "assignee"),
    sessions: Array.isArray(sessions)
      ? sessions.filter((s): s is string => typeof s === "string" && s.length > 0)
      : typeof sessions === "string" && sessions ? [sessions] : [],
    created: stringField(parsed.meta, "created"),
    updated: stringField(parsed.meta, "updated"),
    body: parsed.body.trim(),
    digest: digestOf(content),
  };
}

function readTaskFile(absPath: string, relPath: string, status: string): ProjectTask | null {
  const stat = statSync(absPath);
  if (!stat.isFile() || stat.size > MAX_TASK_BYTES) return null;
  return readTask(readFileSync(absPath, "utf8"), relPath, status);
}

function enabledIn(dir: string): boolean {
  try {
    return statSync(path.join(dir, PROJECT_TASKS_CONFIG)).isFile();
  } catch {
    return false;
  }
}

export function projectTasksEnabled(projectDir: string): boolean {
  try {
    return enabledIn(tasksDir(projectDir));
  } catch {
    return false;
  }
}

function subdirectories(dir: string): Dirent[] {
  try {
    // Dirent does not follow symlinks, so a symlinked folder is never a status.
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

interface Scan {
  board: ProjectTaskBoard;
  // The highest T-<n> anywhere: task ids in front matter, including files the
  // board rejects, and file-name prefixes. A re-added status, a duplicate or an
  // agent's oddly named file never makes an id come round again.
  maxId: number;
}

function scan(dir: string): Scan {
  const enabled = enabledIn(dir);
  const statuses = readStatuses(dir);
  if (!enabled) return { board: { enabled, statuses, tasks: [], problems: [] }, maxId: 0 };
  const tasks: ProjectTask[] = [];
  const problems: ProjectTaskProblem[] = [];
  const known = new Set(statuses);
  const seen = new Set<string>();
  let maxId = 0;
  const countId = (value: string | undefined) => {
    const n = Number(value?.match(/^T-(\d+)/)?.[1] ?? 0);
    if (n > maxId) maxId = n;
  };
  // Known statuses in board order first, so which copy of a duplicate id wins
  // does not depend on the filesystem's readdir order.
  const rank = (name: string) => (known.has(name) ? statuses.indexOf(name) : statuses.length);
  const folders = subdirectories(dir).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  for (const entry of folders) {
    const files = readdirSync(path.join(dir, entry.name), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".md") || file.name.startsWith(".")) continue;
      if (tasks.length + problems.length >= MAX_TASKS) break;
      countId(file.name);
      const relPath = `${PROJECT_TASKS_DIR}/${entry.name}/${file.name}`;
      let task: ProjectTask | null;
      try {
        task = readTaskFile(path.join(dir, entry.name, file.name), relPath, entry.name);
      } catch {
        task = null;
      }
      if (!task) {
        problems.push({ path: relPath, reason: "INVALID_FILE" });
        continue;
      }
      countId(task.id);
      if (!known.has(entry.name)) {
        problems.push({ path: relPath, reason: "UNKNOWN_STATUS", id: task.id });
      } else if (seen.has(task.id)) {
        problems.push({ path: relPath, reason: "DUPLICATE_ID", id: task.id });
      } else {
        seen.add(task.id);
        tasks.push(task);
      }
    }
  }
  tasks.sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
  problems.sort((a, b) => a.path.localeCompare(b.path));
  return { board: { enabled, statuses, tasks, problems }, maxId };
}

export function projectTaskBoard(projectDir: string): ProjectTaskBoard {
  let dir: string;
  try {
    dir = tasksDir(projectDir);
  } catch (error) {
    if (error instanceof ProjectTasksError) return { enabled: false, statuses: [...DEFAULT_TASK_STATUSES], tasks: [], problems: [] };
    throw error;
  }
  return scan(dir).board;
}

function configFor(statuses: readonly string[]): string {
  return `# Task statuses, in board order. Each status is a folder next to this file.
# Renaming a status means renaming its folder too; remove a status only once
# its folder is empty. Deleting this file turns project tasks off.
statuses:
${statuses.map((status) => `  - ${status}`).join("\n")}
`;
}

// The rules agents follow. Sessions only get a pointer to this file, so the
// project can tighten or extend them without a Peon release.
export const TASKS_README_TEMPLATE = `# Tasks

Every task is one Markdown file: \`docs/tasks/<status>/<id>-<slug>.md\`.

## Status is the folder

- Change a task's status by moving its file to another status folder
  (\`git mv\` in a git checkout). Never add a \`status\` field.
- The statuses and their order are listed in \`config.yml\`. Only those folders
  are statuses; a task anywhere else is shown as a problem, not guessed at.
- Renaming a status: rename its folder and its entry in \`config.yml\` together.
  Remove a status only after moving its tasks out.
- Status folders are flat. No subfolders, including in \`done/\`.

## A task file

\`\`\`markdown
---
id: T-42
title: Short imperative title
assignee: someone@example.com
sessions: [peon-id/session-id]
created: 2026-01-31
updated: 2026-01-31
---

What needs to be done, why, and how to check it.
\`\`\`

- The header is YAML. \`id\` and \`title\` are required; quote a title that
  contains \`:\` or starts with a special character. Other keys are optional;
  extra keys (\`priority\`, \`labels\`, ...) are allowed.
- New id: one more than the highest \`T-<n>\` used by any task in any folder
  here, whatever its file is called.
- Update \`updated\` when you change a task. Add your session to \`sessions\`
  when you work on it.

## Referring to tasks

Refer to tasks by id (\`T-42\`), never by path: the path changes on every
status move.
`;

function writeIfMissing(file: string, content: string): void {
  try {
    writeFileSync(file, content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

// Statuses for a project being set up: the parked config from an API turn-off
// first; otherwise the folders already there (defaults in default order, then
// the rest alphabetically); otherwise the defaults.
function statusesForSetup(dir: string): string[] {
  try {
    const parked = parseYaml(readFileSync(path.join(dir, PROJECT_TASKS_PARKED_CONFIG), "utf8"), { schema: "core" }) as { statuses?: unknown } | null;
    const statuses = statusesFrom(parked?.statuses);
    if (statuses) return statuses;
  } catch {
    // No parked config, or an unreadable one: fall through to the folders.
  }
  const folders = subdirectories(dir).map((entry) => entry.name).filter((name) => STATUS_PATTERN.test(name));
  if (!folders.length) return [...DEFAULT_TASK_STATUSES];
  const defaults = DEFAULT_TASK_STATUSES.filter((status) => folders.includes(status));
  const others = folders.filter((name) => !(DEFAULT_TASK_STATUSES as readonly string[]).includes(name)).sort();
  return [...defaults, ...others];
}

export function enableProjectTasks(projectDir: string): ProjectTaskBoard {
  const dir = tasksDir(projectDir);
  if (enabledIn(dir)) {
    throw new ProjectTasksError(409, "TASKS_ALREADY_ENABLED", "project tasks are already set up");
  }
  mkdirSync(dir, { recursive: true });
  const statuses = statusesForSetup(dir);
  for (const status of statuses) {
    requireRealDirectory(path.join(dir, status));
    writeIfMissing(path.join(dir, status, ".gitkeep"), "");
  }
  // A README the project already wrote is its own rules; keep it.
  writeIfMissing(path.join(dir, PROJECT_TASKS_README), TASKS_README_TEMPLATE);
  const parked = path.join(dir, PROJECT_TASKS_PARKED_CONFIG);
  const config = path.join(dir, PROJECT_TASKS_CONFIG);
  let restored = false;
  try {
    renameSync(parked, config);
    restored = enabledIn(dir) && statusesFrom((parseYaml(readFileSync(config, "utf8"), { schema: "core" }) as { statuses?: unknown } | null)?.statuses) !== null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!restored) writeAtomic(config, configFor(statuses));
  return scan(dir).board;
}

// Turning tasks off removes only the opt-in: config.yml is parked beside
// itself so a later setup restores the statuses. Task files, folders and the
// README stay where they are.
export function disableProjectTasks(projectDir: string): ProjectTaskBoard {
  const dir = tasksDir(projectDir);
  if (!enabledIn(dir)) {
    throw new ProjectTasksError(409, "TASKS_NOT_ENABLED", "project tasks are not set up");
  }
  renameSync(path.join(dir, PROJECT_TASKS_CONFIG), path.join(dir, PROJECT_TASKS_PARKED_CONFIG));
  return scan(dir).board;
}

function requireEnabled(projectDir: string): { dir: string } & Scan {
  const dir = tasksDir(projectDir);
  const result = scan(dir);
  if (!result.board.enabled) throw new ProjectTasksError(409, "TASKS_NOT_ENABLED", "project tasks are not set up");
  return { dir, ...result };
}

function requireStatus(statuses: string[], status: unknown): string {
  if (typeof status !== "string" || !statuses.includes(status)) {
    throw new ProjectTasksError(400, "UNKNOWN_STATUS", "status is not one of the project's task statuses");
  }
  return status;
}

function requireTitle(title: unknown): string {
  if (typeof title !== "string" || !title.trim() || title.length > MAX_TITLE_LENGTH || /[\r\n]/.test(title)) {
    throw new ProjectTasksError(400, "INVALID_TASK", `title is required, one line, at most ${MAX_TITLE_LENGTH} characters`);
  }
  return title.trim();
}

function optionalBody(body: unknown): string {
  if (body === undefined || body === null) return "";
  if (typeof body !== "string" || body.length > MAX_BODY_LENGTH) {
    throw new ProjectTasksError(400, "INVALID_TASK", "body must be text");
  }
  return body;
}

function optionalAssignee(assignee: unknown): string | null {
  if (assignee === undefined || assignee === null || assignee === "") return null;
  if (typeof assignee !== "string" || assignee.length > 200 || /[\r\n]/.test(assignee)) {
    throw new ProjectTasksError(400, "INVALID_TASK", "assignee must be one line of text");
  }
  return assignee.trim();
}

function optionalSessions(sessions: unknown, current: string[]): string[] {
  if (sessions === undefined) return current;
  if (!Array.isArray(sessions) || sessions.length > 50 || !sessions.every((s) => typeof s === "string" && s && s.length <= 200 && !/[\r\n]/.test(s))) {
    throw new ProjectTasksError(400, "INVALID_TASK", "sessions must be a list of session references");
  }
  return sessions as string[];
}

interface TaskFields {
  title: string;
  assignee: string | null;
  sessions: string[];
  created: string | null;
  updated: string | null;
}

// Sets the known keys on a front matter document and leaves every other key,
// its order and its comments as they were.
function applyFields(doc: Document, id: string, fields: TaskFields): void {
  doc.set("id", id);
  doc.set("title", fields.title);
  for (const key of ["assignee", "created", "updated"] as const) {
    if (fields[key]) doc.set(key, fields[key]);
    else doc.delete(key);
  }
  if (fields.sessions.length) {
    const node = doc.createNode(fields.sessions);
    if (isSeq(node)) node.flow = true;
    doc.set("sessions", node);
  } else {
    doc.delete("sessions");
  }
  // The folder is the status; a status field would only disagree with it.
  doc.delete("status");
}

function renderTask(doc: Document, body: string): string {
  const header = doc.toString({ lineWidth: 0, flowCollectionPadding: false }).replace(/\n*$/, "\n");
  const text = body.trim();
  return `---\n${header}---\n${text ? `\n${text}\n` : ""}`;
}

export function createProjectTask(projectDir: string, input: unknown, now = new Date()): ProjectTask {
  const body = (input ?? {}) as Record<string, unknown>;
  const { dir, board, maxId } = requireEnabled(projectDir);
  if (board.tasks.length + board.problems.length >= MAX_TASKS) {
    throw new ProjectTasksError(409, "TOO_MANY_TASKS", "the project has too many task files");
  }
  const status = requireStatus(board.statuses, body.status ?? board.statuses[0]);
  const fields: TaskFields = {
    title: requireTitle(body.title),
    assignee: optionalAssignee(body.assignee),
    sessions: optionalSessions(body.sessions, []),
    created: today(now),
    updated: today(now),
  };
  const text = optionalBody(body.body);
  const statusDir = path.join(dir, status);
  requireRealDirectory(statusDir);
  const id = `T-${maxId + 1}`;
  const fileName = `${id}-${slugify(fields.title)}.md`;
  const doc = new Document({});
  applyFields(doc, id, fields);
  const content = renderTask(doc, text);
  try {
    writeFileSync(path.join(statusDir, fileName), content, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ProjectTasksError(409, "TASK_CONFLICT", "a task file with that name appeared meanwhile; retry");
    }
    throw error;
  }
  return readTask(content, `${PROJECT_TASKS_DIR}/${status}/${fileName}`, status)!;
}

function requireTask(board: ProjectTaskBoard, id: string, expectedDigest: unknown): ProjectTask {
  const task = board.tasks.find((candidate) => candidate.id === id);
  if (!task) throw new ProjectTasksError(404, "TASK_NOT_FOUND", "task not found");
  if (typeof expectedDigest !== "string" || expectedDigest !== task.digest) {
    throw new ProjectTasksError(409, "TASK_CONFLICT", "the task changed since it was read; reload and retry");
  }
  return task;
}

// Reads a task file that must be a plain file (not a symlink) and still match
// the digest the caller read. Returns the content the write is based on.
function readFenced(absPath: string, digest: string): string {
  if (!lstatSync(absPath).isFile()) throw new ProjectTasksError(400, "PATH_ESCAPE", "task file is not a plain file");
  const content = readFileSync(absPath, "utf8");
  if (digestOf(content) !== digest) {
    throw new ProjectTasksError(409, "TASK_CONFLICT", "the task changed since it was read; reload and retry");
  }
  return content;
}

export function updateProjectTask(projectDir: string, id: string, input: unknown, now = new Date()): ProjectTask {
  const body = (input ?? {}) as Record<string, unknown>;
  const { dir, board } = requireEnabled(projectDir);
  const task = requireTask(board, id, body.digest);
  const absPath = path.join(dir, task.status, path.basename(task.path));
  const fields: TaskFields = {
    title: body.title === undefined ? task.title : requireTitle(body.title),
    assignee: body.assignee === undefined ? task.assignee : optionalAssignee(body.assignee),
    sessions: optionalSessions(body.sessions, task.sessions),
    created: task.created,
    updated: today(now),
  };
  const text = body.body === undefined ? task.body : optionalBody(body.body);
  // Base the rewrite on the exact bytes the digest covers, so a key an agent
  // added after the caller read the task can never be merged in silently.
  const current = readFenced(absPath, task.digest);
  // readTask already proved this front matter is a YAML mapping.
  const doc = parseDocument(current.match(FRONT_MATTER)![1], { schema: "core" });
  applyFields(doc, task.id, fields);
  const content = renderTask(doc, text);
  writeAtomic(absPath, content);
  return readTask(content, task.path, task.status)!;
}

// A move is a rename into another status folder; the file itself is unchanged.
export function moveProjectTask(projectDir: string, id: string, input: unknown): ProjectTask {
  const body = (input ?? {}) as Record<string, unknown>;
  const { dir, board } = requireEnabled(projectDir);
  const task = requireTask(board, id, body.digest);
  const status = requireStatus(board.statuses, body.status);
  if (status === task.status) return task;
  const fileName = path.basename(task.path);
  const source = path.join(dir, task.status, fileName);
  const content = readFenced(source, task.digest);
  const targetDir = path.join(dir, status);
  requireRealDirectory(targetDir);
  const target = path.join(targetDir, fileName);
  let occupied = true;
  try {
    lstatSync(target);
  } catch {
    occupied = false;
  }
  if (occupied) throw new ProjectTasksError(409, "TASK_CONFLICT", "a file with the same name already exists in the target status");
  renameSync(source, target);
  return readTask(content, `${PROJECT_TASKS_DIR}/${status}/${fileName}`, status)!;
}
