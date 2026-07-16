import { NavLink, useParams } from "react-router-dom";
import { useT } from "../../i18n";
import { usePeon } from "./context";

export function ProjectTabs() {
  const t = useT();
  const { peon, isOwner } = usePeon();
  const { key = "" } = useParams();
  const base = `/peons/${encodeURIComponent(peon.peonId)}/projects/${encodeURIComponent(key)}`;
  const tabClass = ({ isActive }: { isActive: boolean }) =>
    `border-b-2 px-1 pb-2.5 font-display text-xs font-semibold transition-colors ${isActive ? "border-fel text-fel-bright" : "border-transparent text-bone-faint hover:text-bone"}`;

  return (
    <nav className="mb-4 flex gap-5 border-b border-iron-800" aria-label={t("proj.tabs")}>
      <NavLink to={base} end className={tabClass}>{t("proj.tab.overview")}</NavLink>
      <NavLink to={`${base}/files`} className={tabClass}>{t("proj.tab.files")}</NavLink>
      <NavLink to={`${base}/skills`} className={tabClass}>{t("proj.tab.skills")}</NavLink>
      {isOwner && <NavLink to={`${base}/members`} className={tabClass}>{t("proj.tab.members")}</NavLink>}
      {isOwner && <NavLink to={`${base}/settings`} className={tabClass}>{t("proj.tab.settings")}</NavLink>}
    </nav>
  );
}
