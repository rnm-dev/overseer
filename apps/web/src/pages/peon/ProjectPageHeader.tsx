import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router";
import { ContentHeaderIdentitySkeleton, ContentHeaderLayout, ContentHeaderTitle, FixedPaneHeader } from "../../ui";
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

export function ProjectHeaderLayout({
  title,
  newSessionTo,
  loading = false,
  showNewSession = true,
}: {
  title: string;
  newSessionTo: string;
  loading?: boolean;
  showNewSession?: boolean;
}) {
  const t = useT();
  return (
    <ContentHeaderLayout
      identity={loading ? <ContentHeaderIdentitySkeleton label={t("app.loading")} /> : (
        <ContentHeaderTitle title={title}>{title}</ContentHeaderTitle>
      )}
      actions={showNewSession
        ? <Link to={newSessionTo} className="btn btn-fel btn-sm h-7">{t("newSession.new")}</Link>
        : undefined}
    />
  );
}

export function ProjectDesktopHeader({
  title,
  newSessionTo,
  loading,
  showNewSession,
}: {
  title: string;
  newSessionTo: string;
  loading: boolean;
  showNewSession: boolean;
}) {
  return (
    <FixedPaneHeader className="hidden md:block">
      <ProjectHeaderLayout
        title={title}
        newSessionTo={newSessionTo}
        loading={loading}
        showNewSession={showNewSession}
      />
    </FixedPaneHeader>
  );
}

export function ProjectPageHeader({
  name,
  showDesktopNewSession = true,
}: {
  name?: string;
  showDesktopNewSession?: boolean;
}) {
  const { peon, base } = usePeon();
  const { key = "" } = useParams();
  const [loadedProject, setLoadedProject] = useState<{ key: string; name: string } | null>(null);
  const [mobileHeaderNode, setMobileHeaderNode] = useState<HTMLElement | null>(null);
  const loadedName = loadedProject?.key === key ? loadedProject.name : "";
  const title = name || loadedName || key;
  const desktopLoading = !name && loadedProject?.key !== key;

  useEffect(() => {
    if (name) return;
    let alive = true;
    getProjectSettings(base, key)
      .then((settings) => { if (alive) setLoadedProject({ key, name: settings.name }); })
      .catch(() => { if (alive) setLoadedProject({ key, name: "" }); });
    return () => { alive = false; };
  }, [base, key, name]);

  useEffect(() => {
    setMobileHeaderNode(document.getElementById(MOBILE_CONTENT_HEADER_ID));
  }, []);

  const newSessionTo = `/peons/${encodeURIComponent(peon.peonId)}/sessions/new?project=${encodeURIComponent(key)}`;

  return <>
    {mobileHeaderNode && createPortal(
      <ProjectMobileHeader title={title} newSessionTo={newSessionTo} />,
      mobileHeaderNode,
    )}
    <ProjectDesktopHeader
      title={title}
      newSessionTo={newSessionTo}
      loading={desktopLoading}
      showNewSession={showDesktopNewSession}
    />
  </>;
}
