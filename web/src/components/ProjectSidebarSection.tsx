import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useT } from "../i18n";
import { visibleProjects, type ProjectLite } from "../pages/peon/projectList";
import { FadingTitle } from "./SessionSidebarList";

interface ProjectSidebarSectionProps {
  projects: ProjectLite[] | null;
  error?: boolean;
  to: (project: ProjectLite) => string;
  onNew?: () => void;
}

export function sidebarProjects(projects: ProjectLite[]): ProjectLite[] {
  return visibleProjects(projects).sort((a, b) => {
    const nameA = a.name?.trim() || a.key;
    const nameB = b.name?.trim() || b.key;
    return nameA.localeCompare(nameB, undefined, { sensitivity: "base" });
  });
}

export function projectStatusLightClass(activeCount?: number): string {
  return (activeCount ?? 0) > 0
    ? "bg-fel-bright shadow-[0_0_4px_var(--color-fel),0_0_11px_var(--color-fel)]"
    : "bg-iron-700";
}

export function ProjectSidebarSection({ projects, error = false, to, onNew }: ProjectSidebarSectionProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(true);
  const visible = sidebarProjects(projects ?? []);

  return (
    <section>
      <div className="flex items-center justify-between px-2 pb-1 pt-2 md:pl-3.5 md:pr-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="peon-sidebar-projects"
          className="-ml-1 flex min-w-0 items-center gap-1 font-display text-[0.58rem] uppercase tracking-[0.16em] text-bone-faint transition-colors hover:text-bone"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          <span>{t("peon.tab.projects")}</span>
        </button>
        {onNew && (
          <button
            type="button"
            className="font-display text-[0.58rem] uppercase tracking-[0.16em] text-bone-dim transition-colors hover:text-fel-bright"
            onClick={onNew}
          >
            {t("newProject.new")}
          </button>
        )}
      </div>
      {expanded && (
        <div id="peon-sidebar-projects" className="px-2 pb-2 md:pl-3.5 md:pr-1">
          {projects === null && !error ? (
            <div className="flex min-h-8 items-center justify-center">
              <span className="forge-spin scale-75" role="status" aria-label={t("projects.loading")} />
            </div>
          ) : error && visible.length === 0 ? (
            <p className="px-2 py-2 font-body text-xs text-bone-faint">{t("error.loadFailed")}</p>
          ) : visible.length === 0 ? (
            <p className="px-2 py-2 font-body text-xs text-bone-faint">{t("peon.projects.empty")}</p>
          ) : (
            <nav aria-label={t("peon.tab.projects")}>
              <ul className="space-y-0.5">
                {visible.map((project) => (
                  <li key={project.projectId ?? project.key}>
                    <NavLink
                      to={to(project)}
                      className={({ isActive }) => `block rounded px-2.5 py-1.5 transition-colors ${isActive ? "bg-fel/10" : "hover:bg-iron-900"}`}
                      title={project.name ?? project.key}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 flex-none rounded-full ${projectStatusLightClass(project.activeCount)}`} aria-hidden />
                        <span className="min-w-0 flex-1 whitespace-nowrap font-display text-[0.8rem] text-bone">
                          <FadingTitle>{project.name?.trim() || project.key}</FadingTitle>
                        </span>
                      </div>
                      <div className="mt-0.5 flex items-center gap-1.5 pl-3 font-body text-[0.65rem] text-bone-faint">
                        <span className="flex-none">{t("peon.projects.members", { n: project.memberCount ?? 0 })}</span>
                        <span className="flex-none text-bone-dim" aria-hidden>•</span>
                        <span className="flex-none">{t("peon.projects.sessions", { n: project.sessionCount ?? 0 })}</span>
                        {(project.activeCount ?? 0) > 0 && (
                          <span className="ml-auto flex-none text-forge">{t("peon.projects.active", { n: project.activeCount ?? 0 })}</span>
                        )}
                      </div>
                    </NavLink>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      )}
    </section>
  );
}
