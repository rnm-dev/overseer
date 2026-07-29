# Peon documentation

Peon is a local Node.js/TypeScript service for running and supervising unattended Claude Code and Codex sessions.

## Durable project memory

When a user asks an agent to remember project information or instructions, the agent persists
that context in `docs/`. Focused details belong in a focused document. Critical instructions and
processes that must apply to every task belong directly in this index.

For a project-linked session, Peon injects the current contents of `docs/index.md` into the main
agent prompt on every run and follow-up. This makes the index the concise, always-on project
context; linked documents remain available for details that are only relevant to some tasks.

When a project is created, Peon automatically starts a linked documentation-onboarding session
and opens it in the dashboard. The agent first inspects the repository without editing it, asks
3–5 concise questions, and waits for the user's answers before writing lightweight baseline
documentation. Failure to start this optional session must not roll back project creation.

## Reference

- [Architecture](architecture.md)
- Overseer protocol: repository-root `PROTOCOL.md`
- [Armory v1 contracts](armory-v1-contracts.md)
- [Codex app-server migration specification](codex-app-server-migration-spec.md)
- [Transcript pagination](transcript-pagination.md)
- [Session orchestration MCP](session-orchestration.md)
- [Canonical token-usage analytics](token-usage-analytics.md)
- [Reverse command protocol v1](reverse-command-protocol-v1.md)

Project documentation belongs in this directory. Add focused sub-pages as the project evolves and link the important entry points from this index.

Documentation cross-references use Markdown paths relative to the file containing the link. A
normalized local target must remain beneath `docs/`; absolute filesystem paths and `file://`
URLs are not valid cross-references. `../` is acceptable from nested pages only when it still
resolves inside `docs/`. External `https://` links are unaffected.

## Migrated project information

- [Legacy project metadata](legacy-project-metadata.md)
