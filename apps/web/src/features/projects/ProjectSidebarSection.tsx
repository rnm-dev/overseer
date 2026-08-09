import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ExternalLink, MoreHorizontal } from "lucide-react";
import { NavLink } from "react-router";
import { useT } from "../../shared/i18n";
import { visibleProjects, type ProjectLite } from "./projectList";
import { FadingTitle } from "../sessions/SessionSidebarList";
import {
  rowEdgeClass,
  SIDEBAR_ROW_EDGE_IDLE_CLASS,
  SIDEBAR_SECTION_ACTION_CLASS,
  SidebarSectionHeader,
  useRowUpdateFlashes,
} from "../../shared/SidebarSectionHeader";

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

export function projectStatusEdgeClass(activeCount?: number): string {
  return (activeCount ?? 0) > 0
    ? "bg-accent-strong status-edge status-edge--accent"
    : SIDEBAR_ROW_EDGE_IDLE_CLASS;
}

// A project row moves on its own counts and on activity inside its sessions —
// the latter arrives as lastActivityMs from withLiveActiveSessionCounts, so a
// session update flashes its project row too, not only the session row.
export function projectRowFingerprint(project: ProjectLite): string {
  return [
    project.name ?? "",
    project.activeCount ?? 0,
    project.sessionCount ?? 0,
    project.unreadCount ?? 0,
    project.lastActivityMs ?? 0,
  ].join("|");
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
  const flashes = useRowUpdateFlashes(visible.map((project) => ({
    key: project.projectId ?? project.key,
    fingerprint: projectRowFingerprint(project),
  })));
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
      <SidebarSectionHeader
        label={t("peon.tab.projects")}
        expanded={expanded}
        onToggle={toggleExpanded}
        controls="peon-sidebar-projects"
        action={onNew && (
          <button type="button" className={SIDEBAR_SECTION_ACTION_CLASS} onClick={onNew}>
            {t("newProject.new")}
          </button>
        )}
      />
      {expanded && (
        <div id="peon-sidebar-projects">
          {projects === null && !error ? (
            <div className="flex min-h-8 items-center justify-center">
              <span className="loading-spinner scale-75" role="status" aria-label={t("projects.loading")} />
            </div>
          ) : error && visible.length === 0 ? (
            <p className="px-3 py-2 font-body text-xs text-ink-faint">{t("error.loadFailed")}</p>
          ) : visible.length === 0 ? (
            <p className="px-3 py-2 font-body text-xs text-ink-faint">{t("peon.projects.empty")}</p>
          ) : (
            <nav aria-label={t("peon.tab.projects")}>
              <ul className="py-1">
                {visible.map((project) => {
                  const rowKey = project.projectId ?? project.key;
                  const flash = flashes.get(rowKey);
                  return (
                    <li
                      key={rowKey}
                      className="group/project relative flex items-stretch"
                      onContextMenu={(event) => {
                        if (!project.quickLinks?.length) return;
                        event.preventDefault();
                        openContextMenu(project, event.clientX, event.clientY);
                      }}
                    >
                      <NavLink
                        to={to(project)}
                        className={({ isActive }) => `relative block min-w-0 flex-1 py-1.5 pl-3 transition-colors ${project.quickLinks?.length ? "pr-8" : "pr-2"} ${isActive ? "bg-accent/10" : "hover:bg-surface-raised"}`}
                        title={project.name ?? project.key}
                      >
                        <span
                          key={`edge-${flash ?? 0}`}
                          className={rowEdgeClass(projectStatusEdgeClass(project.activeCount), flash)}
                          aria-hidden
                        />
                        <span className="block min-w-0 whitespace-nowrap font-display text-[0.8rem] text-ink">
                          <FadingTitle>{project.name?.trim() || project.key}</FadingTitle>
                        </span>
                        {/* Counts read as one sentence: the total first, then only
                            the states that need attention — running in accent green,
                            unread in warning orange, matching the row edge colours. */}
                        <div className="mt-0.5 flex items-center gap-1.5 font-body text-[0.6875rem] text-ink-faint">
                          <span className="flex-none">{t("peon.projects.sessions", { n: project.sessionCount ?? 0 })}</span>
                          {(project.activeCount ?? 0) > 0 && (
                            <>
                              <span className="flex-none text-ink-muted" aria-hidden>•</span>
                              <span className="flex-none text-accent-strong">{t("peon.projects.active", { n: project.activeCount ?? 0 })}</span>
                            </>
                          )}
                          {(project.unreadCount ?? 0) > 0 && (
                            <>
                              <span className="flex-none text-ink-muted" aria-hidden>•</span>
                              <span className="flex-none text-warning">{t("peon.projects.unread", { n: project.unreadCount ?? 0 })}</span>
                            </>
                          )}
                        </div>
                      </NavLink>
                      {!!project.quickLinks?.length && (
                        <button
                          type="button"
                          aria-label={`${t("proj.quickLinks")}: ${project.name?.trim() || project.key}`}
                          aria-haspopup="menu"
                          className="absolute right-1 top-1 grid h-7 w-7 place-items-center rounded text-ink-faint opacity-70 transition-colors hover:bg-surface-hover hover:text-ink focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 md:opacity-0 md:group-hover/project:opacity-100"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            openContextMenu(project, rect.right, rect.bottom);
                          }}
                        >
                          <MoreHorizontal size={14} aria-hidden />
                        </button>
                      )}
                    </li>
                    );
                })}
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
          className="fixed z-[110] w-52 overflow-hidden rounded-lg border border-edge bg-surface py-1 shadow-xl"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="border-b border-edge px-2.5 py-1.5 font-display text-[0.56rem] uppercase tracking-[0.16em] text-ink-faint">
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
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left font-body text-[0.7rem] text-ink-muted transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
                onClick={() => setContextMenu(null)}
              >
                <span className="min-w-0 flex-1 truncate">{link.title}</span>
                <ExternalLink size={12} className="flex-none text-ink-faint" aria-hidden />
              </a>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </section>
  );
}
