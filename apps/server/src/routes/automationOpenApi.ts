import { SERVER_VERSION } from "../shared/serverVersion.js";

const error = {
  type: "object",
  properties: { error: { type: "string" }, code: { type: "string" } },
  required: ["error", "code"],
} as const;

const sessionSummary = {
  type: "object",
  properties: {
    sessionId: { type: "string" },
    status: { type: "string", nullable: true },
    running: { type: "boolean" },
    title: { type: "string", nullable: true },
    projectKey: { type: "string", nullable: true },
    projectId: { type: "string", nullable: true },
    author: { type: "string", nullable: true },
    promptPreview: { type: "string", nullable: true },
    preview: { type: "string", nullable: true },
    outcome: {},
    terminalReason: {},
    startedAt: { type: "integer", nullable: true },
    endedAt: { type: "integer", nullable: true },
    lastActivityAt: { type: "integer", nullable: true },
  },
  required: ["sessionId", "status", "running"],
} as const;

const attachment = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["file", "image"] },
    path: { type: "string", description: "the committed path POST /uploads returned" },
  },
  required: ["type", "path"],
} as const;

const idempotencyKey = {
  name: "Idempotency-Key",
  in: "header",
  required: true,
  schema: { type: "string", maxLength: 255 },
  description: "Retrying with the same key returns the original result instead of acting twice.",
} as const;

const failures = {
  400: { description: "malformed request", content: { "application/json": { schema: error } } },
  401: { description: "missing, invalid, expired or revoked token", content: { "application/json": { schema: error } } },
  404: { description: "outside this token's scope, or gone", content: { "application/json": { schema: error } } },
} as const;

// Served unauthenticated at /api/automation/v1/openapi.json: it describes the
// shape of the surface, never anything about a particular Peon or project.
export function automationOpenApiDocument(publicUrl: string) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Overseer automation API",
      version: SERVER_VERSION,
      description: [
        "Machine control of sessions on one Peon, optionally narrowed to one project.",
        "",
        "Authenticate with `Authorization: Bearer ovsr_at_…`. A token is minted in the",
        "Overseer web UI under the project's settings and is shown exactly once. It can",
        "never do more than the operator who minted it: every request re-checks their",
        "live access, so revoking their grant narrows the token with it.",
      ].join("\n"),
    },
    servers: [{ url: new URL("/api/automation/v1", publicUrl).toString() }],
    security: [{ automationToken: [] }],
    components: {
      securitySchemes: {
        automationToken: { type: "http", scheme: "bearer", bearerFormat: "ovsr_at_<id>.<secret>" },
      },
      schemas: { Error: error, SessionSummary: sessionSummary, Attachment: attachment },
    },
    paths: {
      "/whoami": {
        get: {
          summary: "What this token is",
          description: "Call it once at start-up to fail loudly instead of writing into the wrong project.",
          responses: {
            200: {
              description: "the token's scope and owner",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      tokenId: { type: "string" },
                      label: { type: "string", nullable: true },
                      workspaceId: { type: "string" },
                      peonId: { type: "string" },
                      peonName: { type: "string", nullable: true },
                      projectKey: { type: "string", nullable: true },
                      projectId: { type: "string", nullable: true },
                      owner: { type: "string", format: "email" },
                      expiresAt: { type: "integer", nullable: true },
                    },
                  },
                },
              },
            },
            401: failures[401],
          },
        },
      },
      "/sessions": {
        get: {
          summary: "List and search sessions",
          description: "Answers from Overseer's own index, so it stays fast and still works while the Peon is briefly offline.",
          parameters: [
            { name: "q", in: "query", schema: { type: "string", maxLength: 200 }, description: "substring of the title or the opening prompt, case-insensitive" },
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 25 } },
            { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          ],
          responses: {
            200: {
              description: "one page, newest activity first",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      sessions: { type: "array", items: sessionSummary },
                      total: { type: "integer" },
                      limit: { type: "integer" },
                      offset: { type: "integer" },
                    },
                  },
                },
              },
            },
            401: failures[401],
          },
        },
        post: {
          summary: "Start a session with a message",
          parameters: [idempotencyKey],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    projectKey: { type: "string", description: "ignored on a project-scoped token, which names its own project" },
                    dir: { type: "string" },
                    agent: { type: "string" },
                    model: { type: "string" },
                    reasoningEffort: { type: "string" },
                    attachments: { type: "array", items: attachment },
                  },
                  required: ["prompt"],
                },
              },
            },
          },
          responses: {
            200: {
              description: "the accepted session",
              content: { "application/json": { schema: { allOf: [sessionSummary], description: "carries `sessionId`" } } },
            },
            ...failures,
            403: { description: "the named project is outside this token's reach", content: { "application/json": { schema: error } } },
            409: { description: "the Peon's agent CLI is not signed in, so the session would fail", content: { "application/json": { schema: error } } },
          },
        },
      },
      "/sessions/{sessionId}": {
        get: {
          summary: "Status of one session",
          description: "The supported way to wait for a turn: poll this. Reading also heals a row left `running` by a Peon that died mid-turn.",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }],
          responses: {
            200: { description: "the Peon's authoritative record", content: { "application/json": { schema: sessionSummary } } },
            ...failures,
          },
        },
      },
      "/sessions/{sessionId}/followup": {
        post: {
          summary: "Send a follow-up",
          description: "Queued by the Peon when a turn is already running.",
          parameters: [{ name: "sessionId", in: "path", required: true, schema: { type: "string" } }, idempotencyKey],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    attachments: { type: "array", items: attachment },
                    model: { type: "string" },
                    reasoningEffort: { type: "string" },
                  },
                  required: ["prompt"],
                },
              },
            },
          },
          responses: { 200: { description: "accepted" }, ...failures },
        },
      },
      "/sessions/{sessionId}/transcript": {
        get: {
          summary: "Read the conversation",
          parameters: [
            { name: "sessionId", in: "path", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
            { name: "cursor", in: "query", schema: { type: "string" }, description: "from the previous page; older Peons return every event at once" },
          ],
          responses: {
            200: { description: "transcript events", content: { "application/json": { schema: { type: "object", properties: { events: { type: "array", items: {} } } } } } },
            ...failures,
          },
        },
      },
      "/uploads": {
        post: {
          summary: "Commit a file, then reference it from a message",
          description: "Two steps on purpose: bytes stream here, and the returned `path` goes into `attachments[]`. There is no inline base64.",
          parameters: [
            { name: "name", in: "query", required: true, schema: { type: "string" } },
            { name: "folder", in: "query", schema: { type: "string" }, description: "groups several files for one message; omitted means each upload gets its own" },
            { name: "Peon-Content-Sha256", in: "header", schema: { type: "string" }, description: "hex digest of the body; the Peon verifies what it committed" },
          ],
          requestBody: { required: true, content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } },
          responses: {
            200: {
              description: "the committed receipt",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { path: { type: "string" }, size: { type: "integer" }, sha256: { type: "string" }, transferId: { type: "string" } },
                    required: ["path"],
                  },
                },
              },
            },
            400: failures[400],
            401: failures[401],
          },
        },
      },
    },
  };
}
