export interface NewSessionValues {
  prompt: string;
  projectKey: string;
  dir: string;
  agent: string;
  model: string;
  reasoningEffort: string;
  attachments?: { type: "file" | "image"; path: string; transferId?: string; size?: number; sha256?: string }[];
}

export function buildNewSessionRequest(values: NewSessionValues) {
  const body: {
    prompt: string;
    projectKey?: string;
    dir?: string;
    agent?: string;
    model?: string;
    reasoningEffort?: string;
    attachments?: NewSessionValues["attachments"];
  } = { prompt: values.prompt.trim() || "(see attachments)" };
  if (values.projectKey) body.projectKey = values.projectKey;
  if (values.dir.trim()) body.dir = values.dir.trim();
  if (values.agent) body.agent = values.agent;
  if (values.model) body.model = values.model;
  if (values.reasoningEffort) body.reasoningEffort = values.reasoningEffort;
  if (values.attachments?.length) body.attachments = values.attachments;
  return body;
}
