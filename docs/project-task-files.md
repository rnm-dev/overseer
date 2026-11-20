# Project task files

Built (OVSR-616). A project can keep its tasks as files in its own `docs/`,
the way Jekyll keeps posts: every task is one Markdown file, its metadata lives
in the file's front matter, and the files are versioned with the project's
code.

**Agents in Peon sessions manage the tasks** by editing the files. Overseer
web only shows them; the one thing it writes is the opt-in. A small write API
(create, edit, move) exists for other callers, but nothing in the product uses
it yet and agents are not pointed at it.

## The Peon switch

`tasksEnabled` (default `true`) is a daemon setting, on the Peon's General
settings next to sign-offs. Off, every task route on the Peon refuses with
`409 TASKS_DISABLED`, no session prompt mentions `docs/tasks`, even in an
opted-in project, and the web hides the Tasks view. Task files on disk are
untouched. Overseer reads it for every member through
`GET /workspaces/:wsId/peons/:id/tasks-enabled` (`{ enabled }`); a Peon too
old to report it counts as off.

## Where it shows

The Peon sidebar has a **Tasks** icon between Projects and Sign-offs. Its
sidebar is two lists. **With tasks** — the projects whose `config.yml` exists,
each with its count of open tasks (not in the last status) — comes first, in
full strength with an accent board chip. **Without tasks** follows, quieter,
with a dashed icon and a **Set up** pill on hover; it folds away and the
browser remembers that. Picking any project opens its board in the main pane
(`/peons/:peonId/tasks/:key`). The data is Peon `GET /tasks/projects`
(`projectId`, `key`, `total`, `open`), relayed as `GET .../peons/:id/task-projects`
and narrowed to the projects the caller may open. There is no per-project Tasks
tab.

## Opt-in

Within a Peon that has tasks on, `docs/tasks/config.yml` is the project's switch. A `docs/tasks/` folder without it is
just a folder: the board stays off and agents are told nothing.

- **Set up** (the Set up pill in the Tasks sidebar, or the board; `POST .../tasks/setup`) writes `config.yml` with the
  four default statuses, `README.md` with the rules, and a folder per status
  with a `.gitkeep`. A `README.md` the project already has is kept. Refused
  with `409 TASKS_ALREADY_ENABLED` when already on.
- **Turn off** (the board, `DELETE .../tasks/config`) parks `config.yml` as
  `.config.yml.off`. Task files, folders and the README stay, and setting up
  again restores the parked statuses. If `config.yml` was deleted by hand
  instead, setup takes the statuses from the folders already there (defaults
  in default order, then the rest alphabetically).
- `docs/` and `docs/tasks/` may be symlinks only if they resolve inside the
  project. Writes never follow a symlinked status folder or task file
  (`400 PATH_ESCAPE`); the board ignores symlinked entries.
- Both need `canManageProject`. Reading the board and the task write API need
  `canAccessProject`.

## What agents see

In an opted-in project, the session prompt gets two lines: tasks live in
`docs/tasks/`, read `docs/tasks/README.md` before creating, updating or moving
one. The rules themselves are in that README, which the project owns and may
change without a Peon release. Projects that use another task manager get
nothing, not even the pointer.

## Layout and rules

```
docs/tasks/
  config.yml
  README.md
  todo/
  in-progress/
  review/
  done/
    T-42-file-based-tasks.md
```

- **The folder is the status.** Changing status is moving the file
  (`git mv`). There is no `status` field, so the two can never disagree.
- Status folders are flat; `done/` has no subfolders.
- `config.yml` lists the statuses in board order (default `todo`,
  `in-progress`, `review`, `done`). Renaming a status means renaming its folder
  and its entry together; a status is removed only once its folder is empty.
- File name `<id>-<slug>.md`; the slug keeps letters and digits of any script.
  Front matter is YAML: `id` and `title` required (a file missing either is
  `INVALID_FILE`); `assignee`, `sessions`, `created`, `updated` known; extra
  keys allowed.
- Ids are `T-<n>`, one more than the highest number used anywhere under
  `docs/tasks/`: front matter ids, including files the board rejects, and
  file-name prefixes. Two branches, or an agent racing the API, can still pick
  the same id; the board then reports `DUPLICATE_ID`.
- Refer to tasks by id, never by path: the path changes on every move.

The board reports, without guessing, a task in a folder that is not a status
(`UNKNOWN_STATUS`), a second file with the same id (`DUPLICATE_ID`, the first
in status order wins) and a file without valid front matter (`INVALID_FILE`).

## Where it lives

- Peon: `apps/peon/src/daemon/projects/tasks.ts`, Fleet HTTP under
  `/projects/by-id/:projectId/tasks`:
  - `GET` the board; `POST .../setup`, `DELETE .../config` the opt-in.
  - `POST` create (`title`, optional `status`, `assignee`, `sessions`, `body`):
    next id, exclusive create, lands in the first status by default.
  - `PATCH .../:taskId` edit (`title`, `assignee`, `sessions`, `body`) and
    `POST .../:taskId/move` (`status`). Both carry the `digest` from the last
    read; a stale one gets `409 TASK_CONFLICT`. The digest is checked against
    the file's bytes again right before writing. An edit rewrites only the
    known keys — other keys keep their order, formatting and comments — and is
    written to a temp file and renamed over the task; a move is only a rename.
  - Every write gets `409 TASKS_NOT_ENABLED` until the project opted in.
- Front matter is parsed with the `yaml` package (core schema, so dates stay
  strings). Every function is synchronous, so API calls never interleave; only
  agents editing the same files can race them, and that is reported, not
  prevented.
- Every write scans the whole board first. Fine at hundreds of tasks; at the
  2,000-file cap it is a noticeable synchronous pause.
- Overseer: `/workspaces/:wsId/peons/:id/projects/:projectId/tasks[...]`
  relays to Peon.
- Web: `apps/web/src/features/tasks/` — `PeonTasks.tsx` (the board: a column
  per status, cards that expand to the description) and
  `TaskProjectSidebarList.tsx`; the tab itself is in `fleet/PeonDetail.tsx`.
- Prompt pointer: `apps/peon/src/daemon/sessions/sessionPrompts.ts`.

## Not yet

- No live refresh: the board reloads on open and on Refresh, not when an agent
  moves a file. The [directory watch](project-directory-watch.md) is the
  obvious hook.
- Flutter client.
- The write API is reachable only with an operator's browser session, not with
  [automation API](automation-api.md) tokens.
