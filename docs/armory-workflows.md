# Armory workflow protocol v1

OVSR-555. CRM owns task selection and workflow policy, the Armory package owns
CRM transport and MCP tools, and Peon owns sessions and lease supervision.

An installed package opts in with this manifest field:

```json
{
  "background": {
    "protocol": "armory-workflows-v1",
    "command": { "executable": "node", "args": ["dist/workflow.js"] },
    "pollIntervalSeconds": 30
  }
}
```

Peon invokes the command with one JSON value on stdin and expects one JSON value
on stdout: `{ "ok": boolean, "status": number, "value": object, "mcp"?: object }`.
The package handles credentials and remote API details; secrets never enter the
prompt or public session representation.

## Operations

| operation | input |
| --- | --- |
| `claim` | `requestId`, `consumer` |
| `attach` | `executionId`, `leaseToken`, `sessionId`, `runId` |
| `heartbeat` | the same identifiers plus `state: starting | running` |
| `read` | `executionId`, `leaseToken` |
| `finish` | `executionId`, `leaseToken`, `outcome`, `summary` |

`requestId` is a durable UUID. Peon persists it before claim and reuses it after
an uncertain result. The package sends it as `Idempotency-Key`; CRM retains exact
replays for at least 30 days and returns 409 when the key is reused with another
request. A successful claim contains `execution`, `work`, and the lease token.
The package also reads `/mcp.json` and returns its instructions with the claim.

Peon persists the execution before attachment, reserves a fresh session and run
ID, attaches them, then starts one new session. The prompt contains the trusted
instructions from `/mcp.json` and the untrusted `work` payload as task data.
Only the claimed package receives `PEON_WORKFLOW_EXECUTION` and
`PEON_WORKFLOW_LEASE`; its MCP proxy maps these to `X-Workflow-Execution` and
`X-Workflow-Lease`.

Heartbeat cadence is 30 seconds. CRM returns `server_time` and `expires_at`; Peon
uses their relative duration for its local deadline. A heartbeat renews the lease
for five minutes. HTTP 404/409, local expiry, package unassignment, or an MCP
`lease_lost` response stops further tool use and cancels the session.

When the session ends, Peon maps its result to `succeeded`, `needs_input`,
`failed`, or `cancelled` and calls `finish`. The agent's `scout_finish_stage` MCP
tool remains authoritative for changing the CRM stage; REST finish only records
that the session ended and cannot invent success.

## Scout mapping

Scout uses bearer authentication for REST and MCP. Workflow base is
`/integrations/api/workflow`: `POST /claims`, `POST
/executions/:id/heartbeat`, `GET /executions/:id`, and `POST
/executions/:id/finish`. MCP is streamable HTTP at `/mcp`. CRM validates the
execution, lease, expiry, and opportunity binding atomically on every MCP write.

The first implementation handles deals only. Assignment is explicit per project;
unassigned packages do not poll. Each project/package assignment has at most one
active execution, while independent assignments may run concurrently.
