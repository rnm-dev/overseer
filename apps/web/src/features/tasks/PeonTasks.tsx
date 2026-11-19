import { useState } from "react";
import { useParams } from "react-router";
import { api, ApiError } from "../../shared/api";
import { useApiResource } from "../../shared/useApiResource";
import { Button, Card } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import { Markdown } from "../../shared/RichText";
import { usePeon } from "../fleet/context";
import type { ProjectDetail } from "../fleet/peonApi";

// The Peon's Tasks view (docs/project-task-files.md): the sidebar lists the
// projects, this pane shows the selected project's board. Agents in Peon
// sessions create and move the task files; this page only shows them. Peon
// also has a task write API, but the one write here is the project opt-in.

export interface ProjectTask {
  id: string;
  title: string;
  status: string;
  path: string;
  assignee: string | null;
  sessions: string[];
  created: string | null;
  updated: string | null;
  body: string;
  digest: string;
}

export interface ProjectTaskBoard {
  enabled: boolean;
  statuses: string[];
  tasks: ProjectTask[];
  problems: { path: string; reason: string; id?: string }[];
}

const PROBLEM_LABELS: Record<string, "proj.tasks.problem.UNKNOWN_STATUS" | "proj.tasks.problem.DUPLICATE_ID" | "proj.tasks.problem.INVALID_FILE"> = {
  UNKNOWN_STATUS: "proj.tasks.problem.UNKNOWN_STATUS",
  DUPLICATE_ID: "proj.tasks.problem.DUPLICATE_ID",
  INVALID_FILE: "proj.tasks.problem.INVALID_FILE",
};

export function tasksByStatus(board: ProjectTaskBoard): Map<string, ProjectTask[]> {
  const columns = new Map<string, ProjectTask[]>(board.statuses.map((status) => [status, []]));
  for (const task of board.tasks) columns.get(task.status)?.push(task);
  return columns;
}

export function PeonTasks() {
  const t = useT();
  const { key = "" } = useParams();
  if (!key) {
    return (
      <Card className="grid min-h-60 place-items-center px-6 py-10 text-center">
        <p className="max-w-sm text-sm text-ink-muted">{t("tasks.pickProject")}</p>
      </Card>
    );
  }
  return <ProjectTaskBoardView key={key} projectKey={key} />;
}

function ProjectTaskBoardView({ projectKey: key }: { projectKey: string }) {
  const t = useT();
  const { peon, base } = usePeon();
  const detail = useApiResource<ProjectDetail>(`${base}/projects/${encodeURIComponent(key)}`);
  const projectId = detail.data?.projectId ?? null;
  const tasksPath = projectId ? `${base}/projects/${encodeURIComponent(projectId)}/tasks` : null;
  const board = useApiResource<ProjectTaskBoard>(peon.online ? tasksPath : null, { noStore: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (enable: boolean) => {
    if (!tasksPath || busy) return;
    if (!enable && !window.confirm(t("proj.tasks.disableConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      board.setData(await api<ProjectTaskBoard>(enable ? `${tasksPath}/setup` : `${tasksPath}/config`, { method: enable ? "POST" : "DELETE" }));
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? t("proj.tasks.forbidden") : err instanceof Error ? err.message : t("error.loadFailed"));
      await board.reload();
    } finally {
      setBusy(false);
    }
  };

  const data = board.data;
  const columns = data?.enabled ? tasksByStatus(data) : null;

  return <div className="space-y-3">
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-edge bg-surface-raised/40 px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-sm font-bold text-ink">{detail.data?.label || key}</h2>
          <p className="mt-0.5 text-xs text-ink-faint">{t("proj.tasks.hint")}</p>
        </div>
        {peon.online && data?.enabled && (
          <>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void board.reload()}>{t("proj.tasks.refresh")}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => void toggle(false)}>{t("proj.tasks.disable")}</Button>
          </>
        )}
      </div>
      <div className="p-5">
        {!peon.online && <p role="status" className="font-mono text-sm text-ink-faint">{t("peon.offlineNote")}</p>}
        {peon.online && (board.loading || detail.loading) && !data && <p role="status" className="font-mono text-sm text-ink-faint">{t("proj.tasks.loading")}</p>}
        {peon.online && board.error != null && !data && (
          <p role="alert" className="font-mono text-sm text-danger">⚠ {board.error instanceof ApiError && board.error.status === 404 && board.error.code !== "UNKNOWN_PROJECT" ? t("proj.tasks.unsupported") : t("error.loadFailed")}</p>
        )}
        {error && <p role="alert" className="mb-3 border-l-2 border-danger bg-danger/5 py-2 pl-3 font-mono text-sm text-danger">⚠ {error}</p>}
        {data && !data.enabled && (
          <div className="grid place-items-center gap-3 py-10 text-center">
            <p className="max-w-md text-sm text-ink-muted">{t("proj.tasks.off")}</p>
            <Button size="sm" disabled={busy} onClick={() => void toggle(true)}>{t("proj.tasks.setup")}</Button>
          </div>
        )}
        {columns && (
          <div className="grid gap-3 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${data!.statuses.length}, minmax(12rem, 1fr))` }}>
            {[...columns].map(([status, tasks]) => (
              <section key={status} aria-label={status} className="surface surface--subtle flex min-h-40 flex-col gap-2 p-3">
                <h3 className="flex items-center justify-between font-mono text-xs uppercase tracking-wide text-ink-muted">
                  <span>{status}</span><span className="text-ink-faint">{tasks.length}</span>
                </h3>
                {tasks.map((task) => (
                  <details key={task.id} className="rounded border border-edge bg-surface p-2.5">
                    <summary className="cursor-pointer list-none">
                      <p className="font-mono text-[0.7rem] text-ink-faint">{task.id}</p>
                      <p className="text-sm text-ink">{task.title}</p>
                      {task.assignee && <p className="mt-1 truncate text-xs text-ink-muted">{task.assignee}</p>}
                    </summary>
                    <div className="mt-2 border-t border-edge pt-2 text-sm">
                      {task.body ? <Markdown source={task.body} /> : <p className="text-xs text-ink-faint">{t("proj.tasks.noBody")}</p>}
                      <p className="mt-2 break-all font-mono text-[0.7rem] text-ink-faint">docs/{task.path}</p>
                      {task.updated && <p className="font-mono text-[0.7rem] text-ink-faint">{t("proj.tasks.updated", { date: task.updated })}</p>}
                    </div>
                  </details>
                ))}
              </section>
            ))}
          </div>
        )}
        {data?.enabled && data.problems.length > 0 && (
          <div className="mt-4">
            <h3 className="font-mono text-xs uppercase tracking-wide text-ink-muted">{t("proj.tasks.problems")}</h3>
            <ul className="mt-1 space-y-0.5 font-mono text-xs text-ink-faint">
              {data.problems.map((problem) => <li key={problem.path}>docs/{problem.path} — {t(PROBLEM_LABELS[problem.reason] ?? "proj.tasks.problem.INVALID_FILE")}</li>)}
            </ul>
          </div>
        )}
      </div>
    </Card>
  </div>;
}
