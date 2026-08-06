import { useParams } from "react-router";
import { RouteTabs, type RouteTab } from "../../components/RouteTabs";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { supportsArmoryProjectPackages } from "./armoryApi";

export function ProjectTabs() {
  const t = useT();
  const { peon, isOwner } = usePeon();
  const { key = "" } = useParams();
  const base = `/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}`;
  const tabs: RouteTab[] = [
    { to: base, label: t("proj.tab.overview"), end: true },
    { to: `${base}/files`, label: t("proj.tab.files") },
    { to: `${base}/skills`, label: t("proj.tab.skills") },
  ];
  if (supportsArmoryProjectPackages(peon.capabilities)) tabs.push({ to: `${base}/tools`, label: t("proj.tab.tools") });
  if (isOwner) {
    tabs.push(
      { to: `${base}/members`, label: t("proj.tab.members") },
      { to: `${base}/settings`, label: t("proj.tab.settings") },
    );
  }

  return <RouteTabs ariaLabel={t("proj.tabs")} tabs={tabs} className="mb-4" />;
}
