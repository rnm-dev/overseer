import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { PageHeader } from "../../ui";
import { useT } from "../../i18n";
import { getProjectSettings } from "./peonApi";
import { usePeon } from "./context";

export function ProjectPageHeader({ name }: { name?: string }) {
  const t = useT();
  const { peon, base } = usePeon();
  const { key = "" } = useParams();
  const [loadedName, setLoadedName] = useState("");

  useEffect(() => {
    if (name) return;
    let alive = true;
    getProjectSettings(base, key)
      .then((settings) => { if (alive) setLoadedName(settings.name); })
      .catch(() => {});
    return () => { alive = false; };
  }, [base, key, name]);

  return <PageHeader
    title={name || loadedName || key}
    backTo={`/peons/${encodeURIComponent(peon.peonId)}/projects`}
    backLabel={t("proj.back")}
    actions={<Link to={`/peons/${encodeURIComponent(peon.peonId)}/sessions/new?project=${encodeURIComponent(key)}`} className="btn btn-sm">{t("newSession.new")}</Link>}
    meta={<span className="flex-none font-mono text-xs text-bone-faint">{key}</span>}
  />;
}
