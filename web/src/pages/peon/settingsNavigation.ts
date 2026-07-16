export type PeonSettingsTab = "general" | "agent" | "armory";

export const SOUL_EDITOR_ROWS = 16;

export function peonSettingsTabFromPath(pathname: string): PeonSettingsTab {
  if (pathname.includes("/settings/armory")) return "armory";
  if (pathname.endsWith("/settings/agent")) return "agent";
  return "general";
}

export function peonSettingsPath(peonId: string, tab: PeonSettingsTab = "general", packageId?: string): string {
  const root = `/peons/${encodeURIComponent(peonId)}/settings`;
  if (tab === "general") return root;
  const tabPath = `${root}/${tab}`;
  return packageId ? `${tabPath}/${encodeURIComponent(packageId)}` : tabPath;
}
