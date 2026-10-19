// Session sidebar paging and routing helpers for the Peon detail shell.

export const SESSION_PAGE_SIZE = 50;

export function sessionListRequestPath(workspaceId: string, peonId: string, mode: "grouped" | "flat", projectLimit: number, offset: number): string {
  const base = `/workspaces/${workspaceId}/sessions?peonId=${encodeURIComponent(peonId)}`;
  return mode === "grouped"
    ? `${base}&perProjectLimit=${projectLimit}`
    : `${base}&limit=${SESSION_PAGE_SIZE}&offset=${offset}`;
}

export function isProjectPath(pathname: string): boolean {
  return /\/projects\/[^/]+(?:\/.*)?$/.test(pathname);
}
