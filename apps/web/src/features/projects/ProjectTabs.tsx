import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Boxes, FolderOpen, LayoutDashboard, Settings, Sparkles, Users } from "lucide-react";
import { RouteTabs, type RouteTab } from "../../shared/RouteTabs";
import { useT } from "../../shared/i18n";
import { usePeon } from "../fleet/context";
import { supportsArmoryProjectPackages } from "../armory/armoryValidation";
import { api } from "../../shared/api";

// The desktop project header renders the "header" variant; pages keep the
// "bar" variant for mobile, where the compact top bar has no room.
export function ProjectTabs({ variant = "bar" }: { variant?: "bar" | "header" }) {
  const t = useT();
  const { peon, isOwner, base: apiBase } = usePeon();
  const { key = "" } = useParams();
  const base = `/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}`;
  const [canManageMembers, setCanManageMembers] = useState(isOwner);
  useEffect(() => {
    if (isOwner) {
      setCanManageMembers(true);
      return;
    }
    let alive = true;
    api(`${apiBase}/projects/${encodeURIComponent(key)}/members`).then(() => alive && setCanManageMembers(true)).catch(() => alive && setCanManageMembers(false));
    return () => { alive = false; };
  }, [apiBase, isOwner, key]);
  const tabs: RouteTab[] = [
    { to: base, label: t("proj.tab.overview"), icon: LayoutDashboard, end: true },
    { to: `${base}/files`, label: t("proj.tab.files"), icon: FolderOpen },
    { to: `${base}/skills`, label: t("proj.tab.skills"), icon: Sparkles },
  ];
  if (supportsArmoryProjectPackages(peon.capabilities)) tabs.push({ to: `${base}/tools`, label: t("proj.tab.tools"), icon: Boxes });
  if (canManageMembers) tabs.push({ to: `${base}/members`, label: t("proj.tab.members"), icon: Users });
  if (isOwner) tabs.push({ to: `${base}/settings`, label: t("proj.tab.settings"), icon: Settings });

  return variant === "header"
    ? <RouteTabs ariaLabel={t("proj.tabs")} tabs={tabs} variant="header" />
    : <RouteTabs ariaLabel={t("proj.tabs")} tabs={tabs} className="mb-4 md:hidden" />;
}
