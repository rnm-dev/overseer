(function () {
  const { useState, useEffect, useCallback } = React;
  const { Card, Badge, NavLink, apiGet, useInterval, timeAgo } = window.ACA;

  // Mirrors SessionsCard's own status helpers — kept local so this home-screen
  // card stays self-contained (the originals live inside SessionsCard's IIFE
  // and aren't exported). A running session is amber; a graded one is
  // green/amber/red by result; an ungraded chat-mode finish gets no badge.
  function statusTone(s) {
    if (s.status === "running") return "amber";
    if (s.outcome?.result === "success") return "green";
    if (s.outcome?.result === "needs_human") return "amber";
    return "red";
  }

  function statusLabel(s) {
    if (s.status === "running") return "running";
    return s.outcome?.result ?? "unknown";
  }

  function hasStatusBadge(s) {
    return s.status === "running" || s.outcome !== null;
  }

  function RecentSessionsCard({ onSelectSession, base = "/sessions" }) {
    const [list, setList] = useState([]);
    const [projects, setProjects] = useState([]);

    const load = useCallback(async () => {
      const { body } = await apiGet("/api/v1/sessions");
      setList(body.sessions ?? []);
    }, []);

    useEffect(() => {
      load();
      apiGet("/api/v1/projects").then(({ body }) => setProjects(body?.projects ?? []));
    }, [load]);
    // Same 3s cadence the full Sessions list polls at — a running session's
    // status and stats update in near-real-time without an SSE connection.
    useInterval(load, 3000);

    const projectLabel = useCallback(
      (key) => projects.find((p) => p.key === key)?.label ?? key,
      [projects],
    );

    // Most recently active first, capped at 10.
    const recent = [...list]
      .sort((a, b) => (b.lastActivityAt ?? b.startedAt ?? 0) - (a.lastActivityAt ?? a.startedAt ?? 0))
      .slice(0, 10);

    return (
      <Card title="Recent sessions">
        {recent.length === 0 && <p className="text-sm text-slate-500">No sessions yet.</p>}
        {recent.length > 0 && (
          <div className="-mx-1 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="text-[11px] text-slate-500">
                  <th className="px-1 pb-2 font-medium">Title</th>
                  <th className="px-1 pb-2 font-medium">Project</th>
                  <th className="px-1 pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {recent.map((s) => {
                  const activityAt = s.lastActivityAt ?? s.startedAt;
                  return (
                    <tr key={s.id} className="group hover:bg-slate-800/40">
                      <td className="max-w-0 px-1 py-2.5">
                        <NavLink
                          href={`${base}/${s.id}`}
                          onClick={() => onSelectSession?.(s.id)}
                          className="block min-w-0"
                        >
                          <p className="truncate font-medium text-slate-200 group-hover:text-white">
                            {s.title || s.promptPreview || s.lastMessagePreview || "Untitled session"}
                          </p>
                          <p className="truncate text-xs text-slate-600">{timeAgo(activityAt)}</p>
                        </NavLink>
                      </td>
                      <td className="px-1 py-2.5 align-top">
                        <span className="text-xs text-slate-400">
                          {s.projectKey ? projectLabel(s.projectKey) : <span className="text-slate-600">—</span>}
                        </span>
                      </td>
                      <td className="px-1 py-2.5 align-top">
                        {hasStatusBadge(s) ? (
                          <Badge tone={statusTone(s)}>{statusLabel(s)}</Badge>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    );
  }

  window.ACA.RecentSessionsCard = RecentSessionsCard;
})();
