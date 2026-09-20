# Peon 1.1.0 preparation

Scope: `@rnm-dev/peon@1.1.0`; npm currently serves 1.0.2. Preparation does not
publish npm or create the immutable `peon-v1.1.0` tag.

## Changes

- Armory packages can declare a supervised background workflow. Peon performs
  durable idempotent claims, binds CRM executions to fresh sessions, sends
  heartbeats, reports completion, and cancels work when its lease is lost.
- Workflow credentials and lease tokens stay out of public session views; only
  the bound package receives them in its private MCP process environment.
- History-dependent Codex `thread/resume`, `thread/fork`, and `thread/read` RPCs
  have five minutes instead of the generic 30-second timeout.

This is a minor release because the package manifest and Peon runtime gain new
behavior. Existing packages remain compatible; background polling is opt-in.

## Gates

Preparation passed on 2026-09-20: 616 Peon tests passed with two expected
provider-login skips, all 12 serial tests passed, and typecheck/compile passed.
The packed archive contains 168 files, is 1,305,004 bytes, includes the workflow
runtime, and contains neither source nor tests. A clean-prefix global install
and CLI smoke test passed. SHA-256:
`917b90e77ad04bd598db6b18c15f53b5df8eb245bc39c579473608105bd7d896`.

1. Run the Peon verification suite and rebuild committed `dist`.
2. Inspect `npm pack --dry-run -w @rnm-dev/peon`.
3. Pack the exact archive, install it into a clean prefix, and smoke `peon --help`.
4. Commit and push the clean release candidate.
5. Only after explicit publication approval, recheck npm, tag that commit as
   `peon-v1.1.0`, publish the archive, and verify registry installation.
