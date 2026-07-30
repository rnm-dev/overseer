export function socketWorkspaceForPath(
  pathname: string,
  currentWorkspaceId: string | undefined,
  knownWorkspaceIds: ReadonlySet<string>,
  peonInventoryReady: boolean,
  workspaceIdOfPeon: (peonId: string) => string | undefined,
): string | undefined {
  const parts = pathname.split("/").filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (parts[0] === "workspaces" && parts[1]) {
    const workspaceId = parts[1];
    return knownWorkspaceIds.has(workspaceId) ? workspaceId : undefined;
  }
  if (parts[0] === "peons" && parts[1]) {
    if (!peonInventoryReady) return undefined;
    return workspaceIdOfPeon(parts[1]);
  }
  return currentWorkspaceId;
}
