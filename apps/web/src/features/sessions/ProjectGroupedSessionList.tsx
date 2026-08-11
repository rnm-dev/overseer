import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { Link } from "react-router";
import { useT } from "../../shared/i18n";
import { visibleProjects, type ProjectLite } from "../projects/projectList";
import type { SessionLite } from "./sessionList";
import type { PresenceUser } from "../../realtime/liveSocket";
import { rowEdgeClass } from "../../shared/SidebarSectionHeader";
import { isNavigatePrefetchKey, sessionStatusEdgeClass, SessionSidebarList } from "./SessionSidebarList";

export const GROUPED_PROJECTS_EXPANDED_STORAGE_KEY = "overseer:session-list:expanded-projects";

export interface ProjectSessionGroup {
  id: string;
  project: ProjectLite | null;
  sessions: SessionLite[];
}

export interface ProjectSessionStatusCounts {
  working: number;
  unread: number;
}

export function projectSessionStatusCounts(sessions: SessionLite[]): ProjectSessionStatusCounts {
  return sessions.reduce<ProjectSessionStatusCounts>((counts, session) => ({
    working: counts.working + (session.status === "running" ? 1 : 0),
    unread: counts.unread + (session.attentionUnread ? 1 : 0),
  }), { working: 0, unread: 0 });
}

function StatusBadge({
  className,
  hoverClassName,
  edge,
  count,
  label,
  linkLabel,
  target,
  sessionTo,
  onNavigateIntent,
}: {
  className: string;
  hoverClassName: string;
  edge: string;
  count: number;
  label: string;
  linkLabel: string;
  target: SessionLite | undefined;
  sessionTo?: (session: SessionLite) => string;
  onNavigateIntent?: (session: SessionLite) => void;
}) {
  const body = (
    <>
      <span className={rowEdgeClass(edge, undefined)} aria-hidden />
      {count}
    </>
  );
  if (!target || !sessionTo) {
    return <span className={className} title={label} aria-label={label}>{body}</span>;
  }
  return (
    <Link
      to={sessionTo(target)}
      className={`${className} cursor-pointer transition-colors ${hoverClassName} focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60`}
      title={linkLabel}
      aria-label={linkLabel}
      onPointerDown={() => onNavigateIntent?.(target)}
      onKeyDown={(event) => {
        if (isNavigatePrefetchKey(event.key)) onNavigateIntent?.(target);
      }}
    >
      {body}
    </Link>
  );
}

export function CollapsedProjectStatusBadges({
  sessions,
  sessionTo,
  onNavigateIntent,
}: {
  sessions: SessionLite[];
  sessionTo?: (session: SessionLite) => string;
  onNavigateIntent?: (session: SessionLite) => void;
}) {
  const t = useT();
  const counts = projectSessionStatusCounts(sessions);
  if (!counts.working && !counts.unread) return null;
  return (
    <div className="flex items-center gap-1 px-1" aria-label={t("sessions.project.statusSummary")}>
      {counts.working > 0 && (
        <StatusBadge
          className="relative flex h-5 min-w-5 items-center justify-center rounded-sm bg-accent/[0.06] px-1.5 pl-2 font-mono text-[0.625rem] font-semibold tabular-nums text-accent-strong"
          hoverClassName="hover:bg-accent/20 hover:text-accent-strong"
          edge={sessionStatusEdgeClass("running")}
          count={counts.working}
          label={t("sessions.project.workingCount", { count: counts.working })}
          linkLabel={t("sessions.project.openWorking", { count: counts.working })}
          target={sessions.find((session) => session.status === "running")}
          sessionTo={sessionTo}
          onNavigateIntent={onNavigateIntent}
        />
      )}
      {counts.unread > 0 && (
        <StatusBadge
          className="relative flex h-5 min-w-5 items-center justify-center rounded-sm bg-warning/[0.06] px-1.5 pl-2 font-mono text-[0.625rem] font-semibold tabular-nums text-warning-strong"
          hoverClassName="hover:bg-warning/20 hover:text-warning-strong"
          edge={sessionStatusEdgeClass("completed", true)}
          count={counts.unread}
          label={t("sessions.project.unreadCount", { count: counts.unread })}
          linkLabel={t("sessions.project.openUnread", { count: counts.unread })}
          target={sessions.find((session) => session.attentionUnread)}
          sessionTo={sessionTo}
          onNavigateIntent={onNavigateIntent}
        />
      )}
    </div>
  );
}

function projectIdentity(project: Pick<ProjectLite, "projectId" | "key">): string {
  return project.projectId ? `id:${project.projectId}` : `key:${project.key}`;
}

export function groupSessionsByProject(projects: ProjectLite[], sessions: SessionLite[]): ProjectSessionGroup[] {
  const visible = visibleProjects(projects).sort((left, right) =>
    (left.name?.trim() || left.key).localeCompare(right.name?.trim() || right.key, undefined, { sensitivity: "base" }));
  const groups: ProjectSessionGroup[] = visible.map((project) => ({ id: projectIdentity(project), project, sessions: [] }));
  const byId = new Map(groups.map((group) => [group.id, group]));
  const byKey = new Map(groups.map((group) => [group.project!.key, group]));
  const unassigned: SessionLite[] = [];
  for (const session of sessions) {
    const group = session.projectId ? byId.get(`id:${session.projectId}`) ?? (session.projectKey ? byKey.get(session.projectKey) : undefined) : session.projectKey ? byKey.get(session.projectKey) : undefined;
    (group?.sessions ?? unassigned).push(session);
  }
  if (unassigned.length) groups.push({ id: "unassigned", project: null, sessions: unassigned });
  return groups;
}

export function loadExpandedProjectGroups(storage?: Pick<Storage, "getItem">): string[] | null {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const raw = target?.getItem(GROUPED_PROJECTS_EXPANDED_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : null;
  } catch {
    return null;
  }
}

export function saveExpandedProjectGroups(groups: string[], storage?: Pick<Storage, "setItem">): void {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(GROUPED_PROJECTS_EXPANDED_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Restricted storage must not affect navigation.
  }
}

export function ProjectGroupedSessionList({
  projects,
  sessions,
  projectLimit,
  peonId,
  viewersFor,
  projectTo,
  sessionTo,
  newSessionTo,
  onNewProject,
  onRename,
  onDelete,
  onNavigateIntent,
}: {
  projects: ProjectLite[];
  sessions: SessionLite[];
  projectLimit: number;
  peonId: string;
  viewersFor: (peonId: string, sessionId: string) => PresenceUser[];
  projectTo: (project: ProjectLite) => string;
  sessionTo: (session: SessionLite) => string;
  newSessionTo: (project: ProjectLite | null) => string;
  onNewProject?: () => void;
  onRename: (session: SessionLite, title: string | null) => Promise<void>;
  onDelete: (session: SessionLite) => Promise<void>;
  onNavigateIntent?: (session: SessionLite) => void;
}) {
  const t = useT();
  const groups = useMemo(() => groupSessionsByProject(projects, sessions), [projects, sessions]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(loadExpandedProjectGroups() ?? groups.map((group) => group.id)));

  useEffect(() => {
    if (loadExpandedProjectGroups() !== null) return;
    setExpanded(new Set(groups.map((group) => group.id)));
  }, [groups]);

  const toggle = (id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveExpandedProjectGroups([...next]);
      return next;
    });
  };

  return (
    <div>
      {groups.map((group) => {
        const project = group.project;
        const isExpanded = expanded.has(group.id);
        const controls = `peon-session-project-${group.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
        const label = project?.name?.trim() || project?.key || t("sessions.project.none");
        return (
          <section key={group.id} className="border-b border-edge/70">
            <div className="flex h-7 items-center bg-ink/5">
              <button
                type="button"
                aria-expanded={isExpanded}
                aria-controls={controls}
                aria-label={`${isExpanded ? t("sessions.project.collapse") : t("sessions.project.expand")}: ${label}`}
                className="grid h-7 w-7 flex-none place-items-center border-r border-edge/70 text-ink-faint transition-colors hover:bg-surface-hover hover:text-ink focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
                onClick={() => toggle(group.id)}
              >
                {isExpanded ? <ChevronDown size={13} className="flex-none text-ink-faint" aria-hidden /> : <ChevronRight size={13} className="flex-none text-ink-faint" aria-hidden />}
              </button>
              {project ? (
                <Link
                  to={projectTo(project)}
                  title={label}
                  className="flex h-7 min-w-0 flex-1 items-center truncate px-2 font-body typo-chat-message font-semibold text-ink transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
                >
                  <span className="truncate">{label}</span>
                </Link>
              ) : (
                <span className="flex h-7 min-w-0 flex-1 items-center truncate px-2 font-body typo-chat-message font-semibold text-ink">{label}</span>
              )}
              <div className="ml-auto flex flex-none items-center" role="toolbar" aria-label={label}>
                {!isExpanded && (
                  <CollapsedProjectStatusBadges
                    sessions={group.sessions}
                    sessionTo={sessionTo}
                    onNavigateIntent={onNavigateIntent}
                  />
                )}
                <Link
                  to={newSessionTo(project)}
                  title={t("newSession.new")}
                  aria-label={`${t("newSession.new")}: ${label}`}
                  className="grid h-7 w-7 place-items-center border-l border-edge/70 text-accent-strong transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
                >
                  <Plus size={16} aria-hidden />
                </Link>
              </div>
            </div>
            {isExpanded && (
              <div id={controls}>
                {group.sessions.length === 0 ? (
                  <p className="px-3 py-3 font-body text-xs text-ink-faint">{t("peon.dash.noSessions")}</p>
                ) : (
                  <SessionSidebarList
                    sessions={group.sessions.slice(0, projectLimit)}
                    to={sessionTo}
                    peonIdFor={() => peonId}
                    viewersFor={viewersFor}
                    onRename={onRename}
                    onDelete={onDelete}
                    onNavigateIntent={onNavigateIntent}
                  />
                )}
              </div>
            )}
          </section>
        );
      })}
      {onNewProject && (
        <button
          type="button"
          className="group flex h-7 w-full items-stretch border-b border-dashed border-edge text-left text-ink-faint transition-colors hover:bg-accent/5 hover:text-accent-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
          onClick={onNewProject}
        >
          <span className="grid w-7 flex-none place-items-center border-r border-dashed border-edge opacity-70"><Plus size={14} aria-hidden /></span>
          <span className="flex min-w-0 items-center px-2 font-display text-[0.68rem] font-semibold uppercase tracking-[0.1em]">{t("newProject.title")}</span>
        </button>
      )}
    </div>
  );
}
