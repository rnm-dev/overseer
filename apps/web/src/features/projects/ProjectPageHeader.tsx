import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useParams } from "react-router";
import { ContentHeaderIdentitySkeleton, ContentHeaderLayout, ContentHeaderTitle, FixedPaneHeader } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import type { ProjectSettings } from "../fleet/peonApi";
import { useApiResource } from "../../shared/useApiResource";
import { usePeon } from "../fleet/context";
import { MOBILE_CONTENT_HEADER_ID } from "../sessions/mobileHeader";
import { ProjectTabs } from "./ProjectTabs";

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
      <div className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-ink" title={title}>{title}</div>
    )}
    actions={<Link to={newSessionTo} className="btn btn-sm">{t("newSession.new")}</Link>}
  />;
}

export function ProjectHeaderLayout({
  title,
  newSessionTo,
  loading = false,
  showNewSession = true,
  tabs,
}: {
  title: string;
  newSessionTo: string;
  loading?: boolean;
  showNewSession?: boolean;
  tabs?: ReactNode;
}) {
  const t = useT();
  return (
    <ContentHeaderLayout
      identity={loading ? <ContentHeaderIdentitySkeleton label={t("app.loading")} /> : (
        <ContentHeaderTitle title={title}>{title}</ContentHeaderTitle>
      )}
      actions={tabs || showNewSession ? <>
        {tabs}
        {showNewSession && <Link to={newSessionTo} className="btn btn-accent btn-sm h-7">{t("newSession.new")}</Link>}
      </> : undefined}
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
        tabs={<ProjectTabs variant="header" />}
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
  const project = useApiResource<ProjectSettings>(name ? null : `${base}/projects/${encodeURIComponent(key)}/settings`);
  const [mobileHeaderNode, setMobileHeaderNode] = useState<HTMLElement | null>(null);
  const loadedName = project.data?.name ?? "";
  const title = name || loadedName || key;
  const desktopLoading = !name && project.loading;

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
