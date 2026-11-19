import { useCallback, useEffect, useState } from "react";
import { FolderGit2 } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { api, ApiError } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { FadingTitle } from "../sessions/SessionSidebarList";
import type { ProjectLite } from "../projects/projectList";

// Fired after a project's tasks are set up or turned off, so the sidebar
// list re-reads which projects have tasks.
export const TASK_PROJECTS_CHANGED = "overseer:task-projects-changed";

const byName = (a: ProjectLite, b: ProjectLite) =>
  (a.name || a.key).localeCompare(b.name || b.key, undefined, { sensitivity: "base" });

// The Tasks sidebar: only the projects that set up task files; each opens its
// board in the main pane. `adding` shows the other projects to set one up.
export function TaskProjectSidebarList({ base, projects, error, adding, onAdded }: {
  base: string;
  projects: ProjectLite[] | null;
  error: boolean;
  adding: boolean;
  onAdded: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [enabledIds, setEnabledIds] = useState<Set<string> | null>(null);
  // "unsupported": a Peon from before the task-projects route answers 404.
  const [loadError, setLoadError] = useState<false | "failed" | "unsupported">(false);
  const [settingUp, setSettingUp] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);

  const load = useCallback(() => api<{ projects: { projectId: string }[] }>(`${base}/task-projects`)
    .then((body) => {
      setEnabledIds(new Set(body.projects.map((project) => project.projectId)));
      setLoadError(false);
    })
    .catch((err) => setLoadError(err instanceof ApiError && err.status === 404 && err.code !== "UNKNOWN_PEON" ? "unsupported" : "failed")), [base]);
  useEffect(() => {
    void load();
    window.addEventListener(TASK_PROJECTS_CHANGED, load);
    return () => window.removeEventListener(TASK_PROJECTS_CHANGED, load);
  }, [load]);

  const live = (projects ?? []).filter((project) => !project.deleted && project.projectId);
  const withTasks = enabledIds ? live.filter((project) => enabledIds.has(project.projectId!)).sort(byName) : [];
  const without = enabledIds ? live.filter((project) => !enabledIds.has(project.projectId!)).sort(byName) : [];

  const setUp = async (project: ProjectLite) => {
    setSettingUp(project.projectId!);
    setSetupError(null);
    try {
      await api(`${base}/projects/${encodeURIComponent(project.projectId!)}/tasks/setup`, { method: "POST" });
      window.dispatchEvent(new Event(TASK_PROJECTS_CHANGED));
      onAdded();
      navigate(`tasks/${encodeURIComponent(project.key)}`);
    } catch (err) {
      setSetupError(err instanceof ApiError && err.status === 403 ? t("proj.tasks.forbidden") : err instanceof Error ? err.message : t("error.generic"));
    } finally {
      setSettingUp(null);
    }
  };

  if ((projects === null && !error) || (enabledIds === null && !loadError)) {
    return (
      <div className="flex min-h-12 items-center justify-center">
        <span className="loading-spinner scale-75" role="status" aria-label={t("projects.loading")} />
      </div>
    );
  }
  if (loadError === "unsupported") {
    return <p className="px-3 py-2 font-body text-xs text-ink-faint">{t("proj.tasks.unsupported")}</p>;
  }
  if (loadError || (error && live.length === 0)) {
    return <p className="px-3 py-2 font-body text-xs text-ink-faint">{t("error.loadFailed")}</p>;
  }

  const rowClass = "flex min-h-8 w-full items-center gap-2 py-1.5 pl-3 pr-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60";
  return (
    <>
      {adding && (
        <section className="border-b border-edge pb-1" aria-label={t("tasks.addProject")}>
          <p className="px-3 py-1.5 font-body text-[0.6875rem] text-ink-faint">{t("tasks.addHint")}</p>
          {without.length === 0 ? (
            <p className="px-3 pb-2 font-body text-xs text-ink-faint">{t("tasks.allSetUp")}</p>
          ) : (
            <ul>
              {without.map((project) => (
                <li key={project.projectId}>
                  <button type="button" disabled={settingUp !== null} onClick={() => void setUp(project)} className={`${rowClass} hover-wash disabled:opacity-50`}>
                    <FolderGit2 size={14} aria-hidden className="flex-none text-ink-faint" />
                    <span className="min-w-0 flex-1 whitespace-nowrap font-body typo-chat-message text-ink-muted"><FadingTitle>{project.name || project.key}</FadingTitle></span>
                    {settingUp === project.projectId && <span className="loading-spinner scale-50" role="status" aria-label={t("proj.tasks.setup")} />}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {setupError && <p className="px-3 pb-2 font-mono text-xs text-danger">⚠ {setupError}</p>}
        </section>
      )}
      {withTasks.length === 0 ? (
        <p className="px-3 py-2 font-body text-xs text-ink-faint">{t("tasks.noProjects")}</p>
      ) : (
        <ul className="pb-1" aria-label={t("tasks.tab")}>
          {withTasks.map((project) => (
            <li key={project.projectId}>
              <NavLink
                to={`tasks/${encodeURIComponent(project.key)}`}
                className={({ isActive }) => `${rowClass} ${isActive ? "bg-accent/10" : "hover-wash"}`}
              >
                <FolderGit2 size={14} aria-hidden className="flex-none text-ink-muted" />
                <span className="min-w-0 flex-1 whitespace-nowrap font-body typo-chat-message text-ink"><FadingTitle>{project.name || project.key}</FadingTitle></span>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
