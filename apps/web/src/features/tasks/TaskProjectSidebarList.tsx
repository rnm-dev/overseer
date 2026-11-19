import { FolderGit2 } from "lucide-react";
import { NavLink } from "react-router";
import { useT } from "../../shared/i18n";
import { FadingTitle } from "../sessions/SessionSidebarList";
import type { ProjectLite } from "../projects/projectList";

// The Tasks sidebar: this Peon's projects; each opens its board in the main pane.
export function TaskProjectSidebarList({ projects, error }: { projects: ProjectLite[] | null; error: boolean }) {
  const t = useT();
  const rows = (projects ?? []).filter((project) => !project.deleted)
    .sort((a, b) => (a.name || a.key).localeCompare(b.name || b.key, undefined, { sensitivity: "base" }));
  if (projects === null && !error) {
    return (
      <div className="flex min-h-12 items-center justify-center">
        <span className="loading-spinner scale-75" role="status" aria-label={t("projects.loading")} />
      </div>
    );
  }
  if (rows.length === 0) {
    return <p className="px-3 py-2 font-body text-xs text-ink-faint">{t(error ? "error.loadFailed" : "tasks.noProjects")}</p>;
  }
  return (
    <ul className="pb-1" aria-label={t("tasks.tab")}>
      {rows.map((project) => (
        <li key={project.projectId ?? project.key}>
          <NavLink
            to={`tasks/${encodeURIComponent(project.key)}`}
            className={({ isActive }) => `flex min-h-8 items-center gap-2 py-1.5 pl-3 pr-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${isActive ? "bg-accent/10" : "hover-wash"}`}
          >
            <FolderGit2 size={14} aria-hidden className="flex-none text-ink-muted" />
            <span className="min-w-0 flex-1 whitespace-nowrap font-body typo-chat-message text-ink"><FadingTitle>{project.name || project.key}</FadingTitle></span>
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
