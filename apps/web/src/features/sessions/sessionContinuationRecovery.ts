import { api } from "../../shared/api";
import type { Ev } from "./parsing";

export type SessionContinuationFailure = "fork_timeout" | "missing_history";

export function sessionContinuationFailure(event: Ev | undefined): SessionContinuationFailure | null {
  if (event?.type !== "result" || event.is_error !== true) return null;
  const details = Array.isArray(event.errors) ? event.errors.filter((item): item is string => typeof item === "string").join("\n") : "";
  if (/thread\/fork timed out after \d+ms/i.test(details)) return "fork_timeout";
  if (/invalid paginated history lineage[\s\S]*missing source rollout/i.test(details)) return "missing_history";
  return null;
}

export function lastUnexecutedUserPrompt(events: Ev[]): string | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!;
    if (event.type === "user_message" && typeof event.text === "string" && event.text.trim()) return event.text.trim();
  }
  return null;
}

export function continuationRecoveryPrompt(sourceSessionId: string, sourceUrl: string, prompt: string | null): string {
  return [
    "Continue the work from a Peon session that could not be resumed.",
    `Source Peon session: ${sourceSessionId}`,
    `Source URL: ${sourceUrl}`,
    "Use the project documentation and current workspace state as the durable context. Do not attempt to fork or resume the source provider thread.",
    prompt ? `The request that was not executed:\n\n${prompt}` : "Ask the operator what should be continued if the durable project context is insufficient.",
  ].join("\n\n");
}

export interface ContinuationSessionValues {
  sourceSessionId: string; sourceUrl: string; prompt: string | null; projectKey: string | null;
  dir: string | null; agent: string | null; model: string | null; reasoningEffort: string | null;
}

export function buildContinuationSessionRequest(values: ContinuationSessionValues) {
  return {
    prompt: continuationRecoveryPrompt(values.sourceSessionId, values.sourceUrl, values.prompt),
    ...(values.projectKey ? { projectKey: values.projectKey } : {}), ...(values.dir ? { dir: values.dir } : {}),
    ...(values.agent ? { agent: values.agent } : {}), ...(values.model ? { model: values.model } : {}),
    ...(values.reasoningEffort ? { reasoningEffort: values.reasoningEffort } : {}),
  };
}

export async function createContinuationSession(base: string, values: ContinuationSessionValues): Promise<{ id: string }> {
  const response = await api<{ id?: string; session?: { id?: string } }>(`${base}/sessions`, {
    method: "POST",
    headers: { "Peon-Request-Id": crypto.randomUUID() },
    body: JSON.stringify(buildContinuationSessionRequest(values)),
  });
  const id = response.id ?? response.session?.id;
  if (!id) throw new Error("Overseer returned no session id");
  return { id };
}
