import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, FolderGit2, KanbanSquare, Plus } from "lucide-react";
import { NavLink, useNavigate } from "react-router";
import { api, ApiError } from "../../shared/api";
import { useT } from "../../shared/i18n";
import { FadingTitle } from "../sessions/SessionSidebarList";
import type { ProjectLite } from "../projects/projectList";

// Fired after a project's tasks are set up or turned off, so the sidebar
// re-reads which projects have tasks.
export const TASK_PROJECTS_CHANGED = "overseer:task-projects-changed";

interface TaskProjectRow {
  projectId: string;
  key: string;
  // Absent on a Peon from before the counts were reported.
  total?: number;
  open?: number;
}

const WITHOUT_COLLAPSED_KEY = "overseer.tasks.withoutCollapsed";

const byName = (a: ProjectLite, b: ProjectLite) =>
  (a.name || a.key).localeCompare(b.name || b.key, undefined, { sensitivity: "base" });

function loadCollapsed(): boolean {
  try {
    return window.localStorage.getItem(WITHOUT_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

// The Tasks sidebar in two lists. On top, the projects that keep task files:
// full-strength rows with an accent board chip and the open-task count. Below,
// the rest: quieter rows with a dashed outline and a Set up action on hover,
// in a section that can be folded away and remembers it.
export function TaskProjectSidebarList({ base, projects, error }: {
  base: string;
  projects: ProjectLite[] | null;
  error: boolean;
}) {
  const t = useT();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Map<string, TaskProjectRow> | null>(null);
  // "unsupported": a Peon from before the task-projects route answers 404.
  const [loadError, setLoadError] = useState<false | "failed" | "unsupported">(false);
  const [settingUp, setSettingUp] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [withoutCollapsed, setWithoutCollapsed] = useState(loadCollapsed);

  const load = useCallback(() => api<{ projects: TaskProjectRow[] }>(`${base}/task-projects`)
    .then((body) => {
      setRows(new Map(body.projects.map((row) => [row.projectId, row])));
      setLoadError(false);
    })
    .catch((err) => setLoadError(err instanceof ApiError && err.status === 404 && err.code !== "UNKNOWN_PEON" ? "unsupported" : "failed")), [base]);
  useEffect(() => {
    void load();
    window.addEventListener(TASK_PROJECTS_CHANGED, load);
    return () => window.removeEventListener(TASK_PROJECTS_CHANGED, load);
  }, [load]);

  const toggleWithout = () => setWithoutCollapsed((collapsed) => {
    try {
      window.localStorage.setItem(WITHOUT_COLLAPSED_KEY, collapsed ? "0" : "1");
    } catch {
      // Private mode: the fold just is not remembered.
    }
    return !collapsed;
  });

  const setUp = async (project: ProjectLite) => {
    setSettingUp(project.projectId!);
    setSetupError(null);
    try {
      await api(`${base}/projects/${encodeURIComponent(project.projectId!)}/tasks/setup`, { method: "POST" });
      window.dispatchEvent(new Event(TASK_PROJECTS_CHANGED));
      navigate(`tasks/${encodeURIComponent(project.key)}`);
    } catch (err) {
      setSetupError(err instanceof ApiError && err.status === 403 ? t("proj.tasks.forbidden") : err instanceof Error ? err.message : t("error.generic"));
    } finally {
      setSettingUp(null);
    }
  };

  if ((projects === null && !error) || (rows === null && !loadError)) {
    return (
      <div className="flex min-h-12 items-center justify-center">
        <span className="loading-spinner scale-75" role="status" aria-label={t("projects.loading")} />
      </div>
    );
  }
  const live = (projects ?? []).filter((project) => !project.deleted && project.projectId);
  // A Peon from before the task-projects route cannot say which projects have
  // tasks, but its boards work: list every project, and say why it is one list.
  if (loadError === "unsupported") {
    return (
      <div className="pb-2">
        <SectionLabel count={live.length}>{t("sidebar.tab.projects")}</SectionLabel>
        <ul>
          {[...live].sort(byName).map((project) => (
            <li key={project.projectId}>
              <NavLink
                to={`tasks/${encodeURIComponent(project.key)}`}
                className={({ isActive }) => `flex min-h-8 items-center gap-2.5 py-1 pl-3 pr-2.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${isActive ? "bg-accent/10" : "hover-wash"}`}
              >
                <span aria-hidden className="grid h-6 w-6 flex-none place-items-center rounded-md bg-surface-raised text-ink-muted">
                  <FolderGit2 size={12} />
                </span>
                <span className="min-w-0 flex-1 whitespace-nowrap font-body text-[0.8125rem] text-ink"><FadingTitle>{project.name || project.key}</FadingTitle></span>
              </NavLink>
            </li>
          ))}
        </ul>
        <Note>{t("tasks.updateForLists")}</Note>
      </div>
    );
  }
  if (loadError || (error && live.length === 0)) return <Note>{t("error.loadFailed")}</Note>;
  if (live.length === 0) return <Note>{t("tasks.noProjects")}</Note>;

  const withTasks = live.filter((project) => rows!.has(project.projectId!)).sort(byName);
  const without = live.filter((project) => !rows!.has(project.projectId!)).sort(byName);

  return (
    <div className="pb-2">
      <SectionLabel count={withTasks.length}>{t("tasks.section.with")}</SectionLabel>
      {withTasks.length === 0 ? (
        <p className="mx-3 mb-2 rounded-md border border-dashed border-edge px-3 py-2.5 font-body text-[0.6875rem] leading-relaxed text-ink-faint">
          {t("tasks.noneWithTasks")}
        </p>
      ) : (
        <ul className="pb-1" aria-label={t("tasks.section.with")}>
          {withTasks.map((project) => {
            const row = rows!.get(project.projectId!)!;
            return (
              <li key={project.projectId}>
                <NavLink
                  to={`tasks/${encodeURIComponent(project.key)}`}
                  className={({ isActive }) => `group relative flex min-h-9 items-center gap-2.5 py-1.5 pl-3 pr-2.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${isActive ? "bg-accent/10" : "hover-wash"}`}
                >
                  {({ isActive }) => (
                    <>
                      {/* The selected row carries an accent rail on its left edge. */}
                      <span aria-hidden className={`absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent transition-opacity ${isActive ? "opacity-100" : "opacity-0"}`} />
                      <span aria-hidden className={`grid h-6 w-6 flex-none place-items-center rounded-md transition-colors ${isActive ? "bg-accent text-on-accent" : "bg-accent/12 text-accent-strong group-hover:bg-accent/20"}`}>
                        <KanbanSquare size={13} />
                      </span>
                      <span className="min-w-0 flex-1 whitespace-nowrap font-body typo-chat-message font-medium text-ink"><FadingTitle>{project.name || project.key}</FadingTitle></span>
                      {typeof row.open === "number" && (
                        <span
                          title={t("tasks.openOfTotal", { open: row.open, total: row.total ?? row.open })}
                          className={`flex-none rounded-full px-1.5 font-body text-[0.625rem] font-semibold leading-4 tabular-nums ${row.open > 0 ? "bg-accent/15 text-accent-strong" : "bg-surface-raised text-ink-faint"}`}
                        >
                          {row.open}
                        </span>
                      )}
                    </>
                  )}
                </NavLink>
              </li>
            );
          })}
        </ul>
      )}

      {without.length > 0 && (
        <>
          <div className="mx-3 my-2 h-px bg-gradient-to-r from-transparent via-edge to-transparent" aria-hidden />
          <SectionLabel count={without.length} collapsed={withoutCollapsed} onToggle={toggleWithout}>{t("tasks.section.without")}</SectionLabel>
          {!withoutCollapsed && (
            <ul aria-label={t("tasks.section.without")}>
              {without.map((project) => {
                const busy = settingUp === project.projectId;
                return (
                  <li key={project.projectId} className="group relative">
                    <NavLink
                      to={`tasks/${encodeURIComponent(project.key)}`}
                      className={({ isActive }) => `flex min-h-8 items-center gap-2.5 py-1 pl-3 pr-20 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${isActive ? "bg-surface-raised/70" : "hover-wash"}`}
                    >
                      <span aria-hidden className="grid h-6 w-6 flex-none place-items-center rounded-md border border-dashed border-edge-strong text-ink-faint transition-colors group-hover:border-ink-faint group-hover:text-ink-muted">
                        <FolderGit2 size={12} />
                      </span>
                      <span className="min-w-0 flex-1 whitespace-nowrap font-body text-[0.8125rem] text-ink-muted transition-colors group-hover:text-ink"><FadingTitle>{project.name || project.key}</FadingTitle></span>
                    </NavLink>
                    {/* A sibling of the link, so setting up never also navigates twice. */}
                    <button
                      type="button"
                      disabled={settingUp !== null}
                      onClick={() => void setUp(project)}
                      aria-label={t("tasks.setUpIn", { name: project.name || project.key })}
                      className={`absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1 rounded-full border border-accent/40 bg-canvas/80 px-2 py-0.5 font-body text-[0.625rem] font-semibold text-accent-strong backdrop-blur transition-all hover:border-accent hover:bg-accent hover:text-on-accent focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-default ${busy ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
                    >
                      {busy ? <span className="loading-spinner scale-50" aria-hidden /> : <Plus size={11} aria-hidden />}
                      <span>{t("tasks.setUp")}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {setupError && <p className="px-3 py-1.5 font-mono text-xs text-danger">⚠ {setupError}</p>}
        </>
      )}
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-3 py-2 font-body text-xs text-ink-faint">{children}</p>;
}

// A small-caps section label with a count; foldable when given a toggle.
function SectionLabel({ children, count, collapsed, onToggle }: {
  children: ReactNode;
  count: number;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      {onToggle && <ChevronRight size={11} aria-hidden className={`flex-none transition-transform ${collapsed ? "" : "rotate-90"}`} />}
      <span className="flex-1 text-left">{children}</span>
      <span className="tabular-nums text-ink-faint">{count}</span>
    </>
  );
  const className = "flex w-full items-center gap-1 px-3 pb-1 pt-2 font-display text-[0.6rem] font-semibold uppercase tracking-[0.14em] text-ink-muted";
  return onToggle ? (
    <button type="button" aria-expanded={!collapsed} onClick={onToggle} className={`${className} transition-colors hover:text-ink`}>{content}</button>
  ) : (
    <h3 className={className}>{content}</h3>
  );
}
