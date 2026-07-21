import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, ApiError } from "../../api";
import { Card, MenuItem, PageHeader } from "../../ui";
import { useT } from "../../i18n";
import { usePeon } from "./context";
import { NewProjectDialog } from "./NewProjectDialog";
import { useLiveSocket, type ProjectLiveEvent } from "../../liveSocket";
import { applyProjectEvent, mergeProjects, visibleProjects, type ProjectLite as Project } from "./projectList";

// author: Viktor

export function PeonProjects() {
  const t = useT();
  const { peon, base, isOwner } = usePeon();
  const { subscribeProjects, subscribeSessions } = useLiveSocket();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  useEffect(() => {
    let alive = true;
    let refreshTimer: number | null = null;
    setProjects(null);
    setUnsupported(false);
    setError(null);
    const load = (surfaceError: boolean) => api<{ projects: Project[] }>(`${base}/projects`)
      .then((r) => {
        if (!alive) return;
        const incoming = (r.projects ?? []).map((project) => ({ ...project, peonId: project.peonId ?? peon.peonId }));
        setProjects((current) => mergeProjects(current ?? [], incoming));
        setUnsupported(false);
        setError(null);
      })
      .catch((err) => {
        if (!alive || !surfaceError) return;
        if (err instanceof ApiError && err.status === 404) setUnsupported(true);
        else setError(err instanceof Error ? err.message : t("error.loadFailed"));
      });
    void load(true);
    const unsubscribeSessions = subscribeSessions((event) => {
      if (event.peonId !== peon.peonId) return;
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
      // Rollups are derived from the local session projection. Refresh once
      // after a burst of session events; this never calls the Peon once its
      // project catalog is canonical.
      refreshTimer = window.setTimeout(() => { void load(false); }, 50);
    });
    return () => {
      alive = false;
      unsubscribeSessions();
      if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    };
  }, [base, peon.peonId, subscribeSessions, t]);

  useEffect(() => subscribeProjects((event: ProjectLiveEvent) => {
    if (event.peonId !== peon.peonId) return;
    setProjects((current) => applyProjectEvent(current ?? [], event));
    setUnsupported(false);
    setError(null);
  }), [peon.peonId, subscribeProjects]);

  const visible = visibleProjects(projects ?? []);
  if (!peon.online && !projects) return <p className="font-mono text-sm text-bone-faint">{t("peon.offlineNote")}</p>;
  if (unsupported && visible.length === 0) return <p className="font-mono text-sm text-bone-faint">{t("peon.unsupported")}</p>;
  if (error && visible.length === 0) return <p className="border-l-2 border-blood bg-blood/5 py-2 pl-3 font-mono text-sm text-blood">⚠ {error}</p>;
  if (!projects) return <div className="forge-spin" />;

  return (
    <div className="space-y-3">
      <PageHeader
        title={t("peon.tab.projects")}
        menuLabel={isOwner ? t("session.menu") : undefined}
        menu={isOwner ? ((close) => (
          <MenuItem
            onClick={() => {
              close();
              setShowNew(true);
            }}
          >
            {t("newProject.new")}
          </MenuItem>
        )) : undefined}
      />
      <Card>
      {visible.length === 0 ? (
        <p className="p-8 text-center font-mono text-sm text-bone-faint">{t("peon.projects.empty")}</p>
      ) : (
        <ul className="divide-y divide-iron-800">
          {visible.map((p) => (
            <li key={p.projectId ?? p.key}>
              <Link to={encodeURIComponent(p.key)} className="flex items-center justify-between gap-3 px-5 py-4 transition-colors hover:bg-fel/[0.03]">
                <div className="min-w-0">
                  <div className="truncate font-display text-sm font-medium text-bone">{p.key}</div>
                  {p.path && <div className="mt-0.5 truncate font-mono text-xs text-bone-faint">{p.path}</div>}
                </div>
                <div className="flex flex-none items-center gap-3 font-mono text-[0.7rem] text-bone-dim">
                  {(p.activeCount ?? 0) > 0 && <span className="text-forge">{t("peon.projects.active", { n: p.activeCount ?? 0 })}</span>}
                  <span>{t("peon.projects.sessions", { n: p.sessionCount ?? 0 })}</span>
                  <span className="text-fel-bright" aria-hidden>›</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
      </Card>
      {showNew && <NewProjectDialog base={base} onClose={() => setShowNew(false)} />}
    </div>
  );
}
