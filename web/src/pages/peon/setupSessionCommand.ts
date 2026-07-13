export interface SetupSessionAttributes {
  projectKey: string;
  dir: string;
  prompt: string;
  expectsOutcome: true;
  agent?: string;
  model?: string;
  reasoningEffort?: string;
}

export interface SetupSessionNavigationState {
  setupSession: SetupSessionAttributes;
  returnTo: string;
}

export type SetupCommandResult =
  | { ok: true; attributes: SetupSessionAttributes }
  | { ok: false; error: string };

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

// Treat lifecycle responses as a protocol boundary. In particular, never let a
// malformed response reach the composer where it could silently fall back to
// an unrelated project, directory, or draft prompt.
export function parseSetupCommand(value: unknown): SetupCommandResult {
  if (!value || typeof value !== "object") return { ok: false, error: "Peon protocol error: invalid setup response." };
  const response = value as { command?: unknown; attributes?: unknown };
  if (typeof response.command !== "string") return { ok: false, error: "Peon protocol error: invalid setup response." };
  if (response.command !== "new_session") return { ok: false, error: `Unsupported Peon command: ${response.command}` };
  if (!response.attributes || typeof response.attributes !== "object") {
    return { ok: false, error: "Peon protocol error: invalid new_session attributes." };
  }
  const attributes = response.attributes as Record<string, unknown>;
  if (
    !isNonEmptyString(attributes.projectKey) ||
    !isNonEmptyString(attributes.dir) ||
    typeof attributes.prompt !== "string" ||
    attributes.expectsOutcome !== true ||
    (attributes.agent !== undefined && typeof attributes.agent !== "string") ||
    (attributes.model !== undefined && typeof attributes.model !== "string") ||
    (attributes.reasoningEffort !== undefined && typeof attributes.reasoningEffort !== "string")
  ) {
    return { ok: false, error: "Peon protocol error: invalid new_session attributes." };
  }
  return {
    ok: true,
    attributes: {
      projectKey: attributes.projectKey,
      dir: attributes.dir,
      prompt: attributes.prompt,
      expectsOutcome: true,
      ...(attributes.agent ? { agent: attributes.agent } : {}),
      ...(attributes.model ? { model: attributes.model } : {}),
      ...(attributes.reasoningEffort ? { reasoningEffort: attributes.reasoningEffort } : {}),
    },
  };
}

export function setupSessionFromNavigationState(value: unknown): SetupSessionAttributes | null {
  if (!value || typeof value !== "object") return null;
  const state = value as { setupSession?: unknown };
  const parsed = parseSetupCommand({ command: "new_session", attributes: state.setupSession });
  return parsed.ok ? parsed.attributes : null;
}

export interface NewSessionValues {
  prompt: string;
  projectKey: string;
  dir: string;
  expectsOutcome?: boolean;
  agent: string;
  model: string;
  reasoningEffort: string;
  attachments?: { type: "file" | "image"; path: string }[];
}

export function buildNewSessionRequest(values: NewSessionValues) {
  const body: {
    prompt: string;
    projectKey?: string;
    dir?: string;
    expectsOutcome?: boolean;
    agent?: string;
    model?: string;
    reasoningEffort?: string;
    attachments?: NewSessionValues["attachments"];
  } = { prompt: values.prompt.trim() || "(see attachments)" };
  if (values.projectKey) body.projectKey = values.projectKey;
  if (values.dir.trim()) body.dir = values.dir.trim();
  if (values.expectsOutcome !== undefined) body.expectsOutcome = values.expectsOutcome;
  if (values.agent) body.agent = values.agent;
  if (values.model) body.model = values.model;
  if (values.reasoningEffort) body.reasoningEffort = values.reasoningEffort;
  if (values.attachments?.length) body.attachments = values.attachments;
  return body;
}
