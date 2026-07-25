import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronRight, ExternalLink, MoreHorizontal } from "lucide-react";
import { NavLink } from "react-router-dom";
import { useT } from "../i18n";
import { visibleProjects, type ProjectLite } from "../pages/peon/projectList";
import { FadingTitle } from "./SessionSidebarList";

export const PROJECT_SIDEBAR_EXPANDED_STORAGE_KEY = "overseer:sidebar:projects-expanded";

interface ProjectSidebarSectionProps {
  projects: ProjectLite[] | null;
  error?: boolean;
  to: (project: ProjectLite) => string;
  onNew?: () => void;
}

export function loadProjectSidebarExpanded(storage?: Pick<Storage, "getItem">): boolean {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    return target?.getItem(PROJECT_SIDEBAR_EXPANDED_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveProjectSidebarExpanded(expanded: boolean, storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(PROJECT_SIDEBAR_EXPANDED_STORAGE_KEY, String(expanded));
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
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

export function projectContextMenuPosition(clientX: number, clientY: number, viewportWidth: number, viewportHeight: number, linkCount: number) {
  const width = 208;
  const height = Math.min(320, 40 + Math.max(1, linkCount) * 32);
  const margin = 8;
  return {
    x: Math.max(margin, Math.min(clientX, viewportWidth - width - margin)),
    y: Math.max(margin, Math.min(clientY, viewportHeight - height - margin)),
  };
}

export function ProjectSidebarSection({ projects, error = false, to, onNew }: ProjectSidebarSectionProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(loadProjectSidebarExpanded);
  const menuRef = useRef<HTMLDivElement>(null);
  const [contextMenu, setContextMenu] = useState<{ project: ProjectLite; x: number; y: number } | null>(null);
  const visible = sidebarProjects(projects ?? []);
  const toggleExpanded = () => {
    setExpanded((current) => {
      const next = !current;
      saveProjectSidebarExpanded(next);
      return next;
    });
  };

  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setContextMenu(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(null);
    };
    const viewport = () => setContextMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    window.addEventListener("scroll", viewport, true);
    window.addEventListener("resize", viewport);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("scroll", viewport, true);
      window.removeEventListener("resize", viewport);
    };
  }, [contextMenu]);

  const openContextMenu = (project: ProjectLite, x: number, y: number) => {
    if (!project.quickLinks?.length) return;
    setContextMenu({ project, ...projectContextMenuPosition(x, y, window.innerWidth, window.innerHeight, project.quickLinks.length) });
  };

  return (
    <section>
      <div className="flex items-center justify-between px-2 pb-1 pt-2 md:pl-3.5 md:pr-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls="peon-sidebar-projects"
          className="-ml-1 flex min-w-0 items-center gap-1 font-display text-[0.58rem] uppercase tracking-[0.16em] text-bone-faint transition-colors hover:text-bone"
          onClick={toggleExpanded}
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
                  <li
                    key={project.projectId ?? project.key}
                    className="group/project relative flex items-stretch"
                    onContextMenu={(event) => {
                      if (!project.quickLinks?.length) return;
                      event.preventDefault();
                      openContextMenu(project, event.clientX, event.clientY);
                    }}
                  >
                    <NavLink
                      to={to(project)}
                      className={({ isActive }) => `block rounded px-2.5 py-1.5 transition-colors min-w-0 flex-1${project.quickLinks?.length ? " pr-8" : ""} ${isActive ? "bg-fel/10" : "hover:bg-iron-900"}`}
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
                    {!!project.quickLinks?.length && (
                      <button
                        type="button"
                        aria-label={`${t("proj.quickLinks")}: ${project.name?.trim() || project.key}`}
                        aria-haspopup="menu"
                        className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded text-bone-faint opacity-70 transition-colors hover:bg-iron-800 hover:text-bone focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-fel/60 md:opacity-0 md:group-hover/project:opacity-100"
                        onClick={(event) => {
                          const rect = event.currentTarget.getBoundingClientRect();
                          openContextMenu(project, rect.right, rect.bottom);
                        }}
                      >
                        <MoreHorizontal size={14} aria-hidden />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      )}
      {contextMenu && createPortal(
        <div
          ref={menuRef}
          role="menu"
          aria-label={`${t("proj.quickLinks")}: ${contextMenu.project.name?.trim() || contextMenu.project.key}`}
          className="fixed z-[110] w-52 overflow-hidden rounded-lg border border-iron-800 bg-iron-950 py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="border-b border-iron-800 px-2.5 py-1.5 font-display text-[0.56rem] uppercase tracking-[0.16em] text-bone-faint">
            {t("proj.quickLinks")}
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {[...(contextMenu.project.quickLinks ?? [])].sort((left, right) => left.order - right.order).map((link) => (
              <a
                key={link.id}
                role="menuitem"
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-body text-[0.7rem] text-bone-dim transition-colors hover:bg-iron-800 hover:text-bone focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fel/60"
                onClick={() => setContextMenu(null)}
              >
                <span className="min-w-0 flex-1 truncate">{link.title}</span>
                <ExternalLink size={12} className="flex-none text-bone-faint" aria-hidden />
              </a>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
