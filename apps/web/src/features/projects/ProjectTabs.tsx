import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { RouteTabs, type RouteTab } from "../../shared/RouteTabs";
import { useT } from "../../shared/i18n";
import { usePeon } from "../fleet/context";
import { supportsArmoryProjectPackages } from "../armory/armoryApi";
import { api } from "../../shared/api";

export function ProjectTabs() {
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
    { to: base, label: t("proj.tab.overview"), end: true },
    { to: `${base}/files`, label: t("proj.tab.files") },
    { to: `${base}/skills`, label: t("proj.tab.skills") },
  ];
  if (supportsArmoryProjectPackages(peon.capabilities)) tabs.push({ to: `${base}/tools`, label: t("proj.tab.tools") });
  if (canManageMembers) tabs.push({ to: `${base}/members`, label: t("proj.tab.members") });
  if (isOwner) tabs.push({ to: `${base}/settings`, label: t("proj.tab.settings") });

  return <RouteTabs ariaLabel={t("proj.tabs")} tabs={tabs} className="mb-4" />;
}
