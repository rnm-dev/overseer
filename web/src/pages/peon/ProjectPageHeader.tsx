import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router-dom";
import { ContentHeaderLayout, PageHeader } from "../../ui";
import { useT } from "../../i18n";
import { getProjectSettings } from "./peonApi";
import { usePeon } from "./context";
import { MOBILE_CONTENT_HEADER_ID } from "./session/mobileHeader";

export function ProjectMobileHeader({
  title,
  newSessionTo,
}: {
  title: string;
  newSessionTo: string;
}) {
  const t = useT();
  return <ContentHeaderLayout
    compact
    identity={(
      <div className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-bone" title={title}>{title}</div>
    )}
    actions={<Link to={newSessionTo} className="btn btn-sm">{t("newSession.new")}</Link>}
  />;
}

export function ProjectPageHeader({ name }: { name?: string }) {
  const t = useT();
  const { peon, base } = usePeon();
  const { key = "" } = useParams();
  const [loadedName, setLoadedName] = useState("");
  const [mobileHeaderNode, setMobileHeaderNode] = useState<HTMLElement | null>(null);
  const title = name || loadedName || key;

  useEffect(() => {
    if (name) return;
    let alive = true;
    getProjectSettings(base, key)
      .then((settings) => { if (alive) setLoadedName(settings.name); })
      .catch(() => {});
    return () => { alive = false; };
  }, [base, key, name]);

  useEffect(() => {
    setMobileHeaderNode(document.getElementById(MOBILE_CONTENT_HEADER_ID));
  }, []);

  const backTo = `/peons/${encodeURIComponent(peon.peonId)}/projects`;
  const newSessionTo = `/peons/${encodeURIComponent(peon.peonId)}/sessions/new?project=${encodeURIComponent(key)}`;
  const action = <Link to={newSessionTo} className="btn btn-sm">{t("newSession.new")}</Link>;

  return <>
    {mobileHeaderNode && createPortal(
      <ProjectMobileHeader title={title} newSessionTo={newSessionTo} />,
      mobileHeaderNode,
    )}
    <PageHeader
      className="hidden md:block"
      title={title}
      backTo={backTo}
      backLabel={t("proj.back")}
      actions={action}
      meta={<span className="flex-none font-mono text-xs text-bone-faint">{key}</span>}
    />
  </>;
}
