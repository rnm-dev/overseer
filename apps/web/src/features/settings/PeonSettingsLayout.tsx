import { Outlet, useLocation } from "react-router";
import { PeonSettings } from "./PeonSettings";
import { useT } from "../../shared/i18n";
import { RouteTabs } from "../../shared/RouteTabs";
import { usePeon } from "../fleet/context";
import { peonSettingsPath, peonSettingsTabFromPath } from "./settingsNavigation";

// Owner-only shell for the Peon settings tabs. General/agent share one
// PeonSettings instance kept mounted here so its form state survives visits to
// the Armory child route, exactly as when every tab lived in one component.
export function PeonSettingsLayout() {
  const t = useT();
  const { peon, isOwner } = usePeon();
  const location = useLocation();
  const settingsPath = peonSettingsPath(peon.peonId);

  if (!isOwner) return <p className="font-mono text-sm text-ink-faint">{t("ownerOnly")}</p>;

  return (
    <div className="space-y-8">
      <RouteTabs
        ariaLabel={t("peon.settings.tabs")}
        tabs={[
          { to: settingsPath, label: t("peon.settings.tab.general"), end: true },
          { to: `${settingsPath}/agent`, label: t("peon.settings.tab.agent") },
          { to: `${settingsPath}/armory`, label: t("peon.settings.tab.armory") },
        ]}
      />
      <PeonSettings tab={peonSettingsTabFromPath(location.pathname)} />
      <Outlet />
    </div>
  );
}
