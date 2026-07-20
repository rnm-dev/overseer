export function peonOverviewSessionsPath(peonId: string, sessionId?: string): string {
  const root = `/peons/${encodeURIComponent(peonId)}/sessions`;
  return sessionId ? `${root}/${encodeURIComponent(sessionId)}` : root;
}

export function peonOverviewNewSessionPath(peonId: string): string {
  return `${peonOverviewSessionsPath(peonId)}/new`;
}

export function peonOverviewProjectsPath(peonId: string, projectKey?: string): string {
  const root = `/peons/${encodeURIComponent(peonId)}/projects`;
  return projectKey ? `${root}/${encodeURIComponent(projectKey)}` : root;
}
