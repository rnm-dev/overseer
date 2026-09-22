# Source-triggered workflows

Polling from Peon or an Armory package is abandoned. The source system owns its
queue and workflow policy. When work becomes eligible, it calls an authenticated
Overseer API to create one Peon session and stores the returned session ID.

The source system uses that ID to read status and outcome, cancel work, or send
additional context. Overseer routes the request to the selected Peon through the
existing Fleet control plane. Peon remains responsible only for executing and
persisting the session; Armory packages provide the MCP tools assigned to its
project.

The trigger contract must define idempotent creation, project and package/tool
selection, task instructions and untrusted payload, source correlation IDs,
status/outcome mapping, cancellation, authorization, and bounded retention.
There is no package background command, claim loop, heartbeat, or CRM lease in
Peon. The exact HTTP contract is a separate design task before implementation.
