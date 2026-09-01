# Project detail

Project rows on the Peon page open a cached-first project surface.

## Navigation and access

The mobile header shows the cached project name immediately and starts a new
session with the current project key. The top-level tabs are Sessions,
Documents, Files, and Settings, with Sessions selected by default. Settings
contains a second-level navigation for General, Skills, and Members. Skills is
available to every operator with project access; General is owner-only.
Members is available to workspace owners and the project's administrators.

The peon online flag controls remote actions. Offline project detail keeps the
cached project identity visible, disables New session, and explains that live
content is unavailable.

## Data flow

`ProjectDetailController` starts with the `PeonProject` row from the
Drift-backed project list. When the Peon is online, it reconciles project detail
and documentation through REST. Other tabs load on first selection.

The web/server contracts are:

```text
GET   /api/workspaces/:workspaceId/peons/:peonId/projects/:projectKey
GET   /api/workspaces/:workspaceId/peons/:peonId/projects/:projectId/docs
GET   /api/workspaces/:workspaceId/peons/:peonId/projects/by-id/:projectId/files/:path
GET   /api/workspaces/:workspaceId/peons/:peonId/projects/:projectKey/files/:path?stat=1
GET   /api/workspaces/:workspaceId/peons/:peonId/projects/:projectKey/skills
GET   /api/workspaces/:workspaceId/peons/:peonId/projects/:projectKey/settings
PATCH /api/workspaces/:workspaceId/peons/:peonId/projects/:projectKey/settings
GET   /api/workspaces/:workspaceId/members
GET   /api/workspaces/:workspaceId/members/:userId/access
PUT   /api/workspaces/:workspaceId/members/:userId/access
```

Canonical `projectId` is used for documentation and file preview so a project
key rename cannot redirect an in-flight read to another project.

## Tabs

### Documents

Documents lists the project documentation root and automatically renders
`docs/index.md` when present. Documentation is limited to 512 KB. Missing,
offline, loading, and retry states stay inside the web-style documentation card
without discarding the cached project header. Markdown links are interactive:
web and email links open externally, links to other files under `docs/` stay in
the Documents reader, and other relative project links open the shared file
viewer.

### Sessions

Sessions reuses the cached/live Peon session list and filters it by canonical
project ID. The project key is a compatibility fallback for projections that
lack an ID. Pagination stays available when the loaded page has no matching
sessions.

### Files

Files reuses the lazily expanded project tree described in
[project-files.md](project-files.md). Compact layouts stack the tree over the
preview; wider layouts place them side by side. Text, Markdown, and supported
images can be previewed. Files over 1 MB show a size guard instead of decoding
unbounded content.

### Settings

Settings provides General, Skills, and Members sections. General and Members
are owner-only; other operators land directly on Skills.

#### General

General mirrors web settings fields: key, label, directory, and metadata. Key,
label, and directory are required. A successful rename updates the open screen
and the project key used by New session, file browsing, and subsequent settings
requests.

#### Skills

Skills validates and renders the name, description, and optional source path
returned by the Peon.

#### Members

Members loads workspace users and the access state for this project only.
Owners are summarized because they always have project access. A project
administrator can toggle regular participants without changing their grants to
other Peons or projects. Canonical project identity is preferred over the
mutable key.

## Verification

Repository tests cover endpoint paths and decoding. Widget tests cover
cached-first rendering, project session filtering, owner settings sections,
lazy loads, and offline/member access. Real-device validation should exercise
Sessions, Documents, a text or Markdown file preview, and every available
Settings section without saving user data.
