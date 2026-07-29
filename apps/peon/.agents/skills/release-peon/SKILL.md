---
name: release-peon
description: Prepare, publish, and verify Peon releases through the global Overseer release registry. Use when asked to release or deploy Peon, bump its version, package or publish a production archive, make committed dist available to Peons, or execute the project shorthand “деплой”.
---

# Release Peon

Release only from the Peon repository root. Treat publishing, pushing, and tagging as production mutations: perform them only when the user explicitly asks to release or deploy.

## Release flow

1. Inspect `git status`, the current branch, the latest tag, `package.json`, and user-visible changes. Preserve unrelated worktree changes.
2. Run `node .agents/skills/release-peon/scripts/publish-release.mjs --preflight` before changing the version, committing, tagging, or pushing. Stop immediately if it cannot resolve a safe registry URL and publisher credential.
3. Check `GET http://127.0.0.1:4570/api/v1/sessions` and refuse to restart or update a Peon while any session has `status: "running"`. Publishing an archive alone does not restart the local daemon.
4. Choose the SemVer bump from the changes unless the user specified it. Update `package.json` and `package-lock.json` with `npm version --no-git-tag-version <version>`; never add npm lifecycle scripts.
5. Update `CHANGELOG.md` for user-visible or noteworthy changes when it exists. Do not create auxiliary release documentation.
6. Run `npm run typecheck`, `npm test`, and `npm run compile`. Include regenerated `dist/` and run `git diff --check`.
7. Commit the complete authorized release worktree, push the current branch directly, create annotated tag `v<version>`, and push that tag. Do not open a PR unless requested.
8. Before upload, prove the package source still matches `v<version>`. If package-affecting files changed after tagging or the checkout is dirty, create a temporary detached worktree at the tag and run the publisher with that worktree as its current directory. Never publish a later archive under an existing version or tag.
9. Run `node <peon-repo>/.agents/skills/release-peon/scripts/publish-release.mjs` from the verified source tree. The script creates an npm archive in a temporary directory, computes its SHA-256, and streams it to the immutable Overseer `PUT /api/releases/:version` endpoint with `Peon-Content-Sha256`. Treat its verified version, size, and digest response as authoritative proof of publication.
10. Keep authentication project-scoped and independent of any Overseer checkout. Resolve it in this order: exported `OVERSEER_RELEASE_TOKEN`, ignored Peon-root `.env.release.local`, then the macOS Keychain item with service `dev.peon.release-peon` and account `OVERSEER_RELEASE_TOKEN`. Never inspect sibling repositories or deployment recipes. Never print, persist in tracked files, or commit the resolved token. `OVERSEER_RELEASE_URL` defaults to `https://overseer.rnm.dev`.
11. Query the authenticated latest-release endpoint only when a Peon credential for the same Overseer origin is available. Otherwise skip this optional check; do not probe production with a local-development Peon credential. Do not trigger fleet updates unless the user separately requests them.

If upload authentication fails, stop after one retry only when configuration was corrected. Report the HTTP status and safe server error without exposing the token. Never retag or republish a different archive under an existing version.

## Update behavior

Publishing makes the committed `dist/` available through Overseer; it does not itself update machines. For a global installation, Overseer can call the fleet `POST /api/v1/control/update` endpoint: Peon downloads the latest archive with its recruitment credential, verifies size and SHA-256, installs it, checks compiled output, restarts services, and rolls back on failure. A source checkout instead fast-forwards its current branch so committed `dist/` arrives with source, then reports that a manual dev-harness restart is required. Respect the active-session guard and do not trigger either rollout unless the user requests it.

For packaging validation without publishing, run the script with `--dry-run`.
