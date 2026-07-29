(function () {
  const { useState, useEffect, useCallback } = React;
  const { Card, Badge, apiGet, PRIORITY_TONE } = window.ACA;

  function TasksCard({ status, refreshToken }) {
    const [data, setData] = useState(null);

    const authenticated = Boolean(status?.authenticated);

    const load = useCallback(async () => {
      if (!authenticated) {
        setData(null);
        return;
      }
      const { body } = await apiGet("/api/v1/tasks");
      setData(body);
    }, [authenticated]);

    useEffect(() => {
      load();
    }, [load, refreshToken]);

    const tasks = data?.tasks ?? null;

    return (
      <Card title="Actionable tasks">
        {!authenticated && <p className="text-sm text-slate-500">Log in to see assigned tasks.</p>}
        {authenticated && data?.error && (
          <p className="mb-3 rounded bg-red-950/60 px-3 py-2 text-xs text-red-300 ring-1 ring-inset ring-red-900">
            {data.error}
          </p>
        )}
        {authenticated && tasks && tasks.length === 0 && (
          <p className="text-sm text-slate-500">Nothing needs action right now.</p>
        )}
        {authenticated && tasks && tasks.length > 0 && (
          <ul className="divide-y divide-slate-800">
            {tasks.map((t) => (
              <li key={`${t.projectKey}-${t.id}`} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-slate-200">{t.title ?? t.id}</p>
                  <p className="text-xs text-slate-500">
                    {t.id} · {t.projectKey}
                  </p>
                </div>
                {t.priority && <Badge tone={PRIORITY_TONE[t.priority] ?? "slate"}>{t.priority}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  window.ACA.TasksCard = TasksCard;
})();
