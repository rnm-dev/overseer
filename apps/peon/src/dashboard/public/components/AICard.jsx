(function () {
  const { useState, useEffect, useCallback } = React;
  const { Card, PageHeader, Badge, Dot, Button, apiGet, formatTokens, formatCost, formatDuration } = window.ACA;

  const PERIODS = [
    { id: "day", label: "Day" },
    { id: "yesterday", label: "Yesterday" },
    { id: "week", label: "Week" },
    { id: "month", label: "Month" },
  ];

  const CONNECTION_BADGES = {
    connected: { tone: "green", dot: "bg-emerald-500", label: "connected" },
    disconnected: { tone: "slate", dot: "bg-slate-500", label: "not connected" },
    error: { tone: "red", dot: "bg-red-500", label: "needs attention" },
    unknown: { tone: "slate", dot: "bg-slate-500", label: "checking" },
  };

  function useProviderStatus(provider, refreshToken) {
    const [status, setStatus] = useState(null);
    const load = useCallback(async () => {
      const { body } = await apiGet(`/api/v1/ai/status/${provider}`);
      setStatus(body);
    }, [provider]);
    useEffect(() => { load(); }, [load, refreshToken]);
    return status;
  }

  function useProviderQuota(provider, refreshToken, enabled) {
    const [quota, setQuota] = useState(null);
    const [refreshing, setRefreshing] = useState(false);
    const load = useCallback(async (force = false) => {
      if (!enabled) {
        setQuota({ status: "unavailable", windows: [], error: "Quota is reported by the shared Codex CLI provider." });
        return;
      }
      setRefreshing(true);
      try {
        const { body } = await apiGet(`/api/v1/ai/quota/${provider}${force ? "?refresh=1" : ""}`);
        setQuota(body);
      } finally {
        setRefreshing(false);
      }
    }, [provider, enabled]);
    useEffect(() => { load(false); }, [load, refreshToken]);
    return { quota, refreshing, refresh: () => load(true) };
  }

  function useProviderCapabilities(provider, refreshToken, enabled) {
    const [capabilities, setCapabilities] = useState(null);
    const [refreshing, setRefreshing] = useState(false);
    const load = useCallback(async (force = false) => {
      if (!enabled) {
        setCapabilities({ plugins: [], skills: [], mcps: [], error: "Runtime capabilities are declared by the app-server driver." });
        return;
      }
      setRefreshing(true);
      try {
        const { body } = await apiGet(`/api/v1/ai/capabilities/${provider}${force ? "?refresh=1" : ""}`);
        setCapabilities(body);
      } finally {
        setRefreshing(false);
      }
    }, [provider, enabled]);
    useEffect(() => { load(false); }, [load, refreshToken]);
    return { capabilities, refreshing, refresh: () => load(true) };
  }

  function useStats(period, refreshToken) {
    const [stats, setStats] = useState(null);
    const load = useCallback(async () => {
      const { body } = await apiGet(`/api/v1/ai/stats?period=${period}`);
      setStats(body);
    }, [period]);
    useEffect(() => { load(); }, [load, refreshToken]);
    return stats;
  }

  function resetLabel(timestamp) {
    if (!timestamp) return "reset unknown";
    const remaining = timestamp - Date.now();
    if (remaining <= 0) return "resetting";
    const minutes = Math.ceil(remaining / 60_000);
    if (minutes < 60) return `resets in ${minutes}m`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 48) return `resets in ${hours}h`;
    return `resets in ${Math.ceil(hours / 24)}d`;
  }

  function QuotaBar({ window }) {
    const color = window.usedPercent >= 90 ? "bg-red-500" : window.usedPercent >= 70 ? "bg-amber-500" : "bg-emerald-500";
    return (
      <div>
        <div className="mb-1 flex items-center justify-between gap-3 text-xs">
          <span className="min-w-0 truncate text-slate-300">
            {window.label}
            {window.modelIds?.length > 0 && <span className="ml-2 text-slate-600">{window.modelIds.join(", ")}</span>}
          </span>
          <span className="flex-none tabular-nums text-slate-400">{Math.round(window.usedPercent)}% · {resetLabel(window.resetsAt)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
          <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.max(1, window.usedPercent)}%` }} />
        </div>
      </div>
    );
  }

  function usageForProvider(stats, provider) {
    const rows = (stats?.byModel ?? []).filter((row) => row.agent === provider);
    return rows.reduce((total, row) => ({
      outputTokens: total.outputTokens + row.outputTokens,
      inputTokens: total.inputTokens + row.inputTokens,
      cacheCreationTokens: total.cacheCreationTokens + row.cacheCreationTokens,
      cacheReadTokens: total.cacheReadTokens + row.cacheReadTokens,
      totalCostUsd: total.totalCostUsd + row.totalCostUsd,
      totalDurationMs: total.totalDurationMs + row.totalDurationMs,
      sessionCount: total.sessionCount + row.sessionCount,
      rows,
    }), {
      outputTokens: 0,
      inputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      totalCostUsd: 0,
      totalDurationMs: 0,
      sessionCount: 0,
      rows,
    });
  }

  function UsageSummary({ usage, loading }) {
    if (loading) return <p className="text-xs text-slate-500">Loading usage…</p>;
    return (
      <div>
        <div className="grid grid-cols-3 gap-3 text-sm">
          <div><p className="text-slate-500">Output</p><p className="font-medium text-slate-200">{formatTokens(usage.outputTokens)}</p></div>
          <div><p className="text-slate-500">Cost</p><p className="font-medium text-slate-200">{formatCost(usage.totalCostUsd)}</p></div>
          <div><p className="text-slate-500">Sessions</p><p className="font-medium text-slate-200">{usage.sessionCount}</p></div>
        </div>
        <p className="mt-2 text-[11px] text-slate-600">
          {formatTokens(usage.inputTokens)} in · {formatTokens(usage.cacheCreationTokens)} cache-write · {formatTokens(usage.cacheReadTokens)} cache-read · {formatDuration(usage.totalDurationMs)}
        </p>
        {usage.rows.length > 0 && (
          <div className="mt-3 space-y-1.5 border-t border-slate-800 pt-3">
            {usage.rows.map((row) => (
              <div key={`${row.agent}:${row.model}`} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-slate-300">{row.model}</span>
                <span className="flex-none tabular-nums text-slate-500">{formatTokens(row.outputTokens)} out · {formatCost(row.totalCostUsd)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  function connectionFor(status, quota) {
    if (status?.status === "healthy") return CONNECTION_BADGES.connected;
    if (["failed", "incompatible"].includes(status?.status)) return CONNECTION_BADGES.error;
    if (["stopped", "starting", "restarting"].includes(status?.status)) return CONNECTION_BADGES.unknown;
    if (status?.authState === "ok") return CONNECTION_BADGES.connected;
    if (status?.authState === "broken") return CONNECTION_BADGES.error;
    if (status?.authState === "unauthenticated") return CONNECTION_BADGES.disconnected;
    if (!quota) return CONNECTION_BADGES.unknown;
    if (quota.status === "ok") return CONNECTION_BADGES.connected;
    if (quota.status === "error") return CONNECTION_BADGES.error;
    return CONNECTION_BADGES.disconnected;
  }

  function connectionDetail(status, quota) {
    if (status?.minimumVersion) {
      if (status.status === "healthy") return `Runtime healthy · Codex ${status.version ?? "version unknown"}`;
      if (status.status === "incompatible") return status.lastError?.message ?? `Requires Codex ${status.minimumVersion} or newer.`;
      if (status.status === "failed") return status.lastError?.message ?? "App-server runtime failed.";
      return `Runtime ${status.status ?? "not started"} · requires Codex ${status.minimumVersion}+`;
    }
    if (status?.cliCheck) {
      if (status.cliCheck.loggedIn) {
        return `Signed in${status.cliCheck.email ? ` as ${status.cliCheck.email}` : ""}`;
      }
      if (status.cliCheck.ran) return "Agent is not signed in.";
      return status.cliCheck.error ?? "Agent authentication is unavailable.";
    }
    if (quota?.status === "ok") return `Signed in${quota.accountEmail ? ` as ${quota.accountEmail}` : ""}`;
    return quota?.error ?? "Checking provider connection…";
  }

  function CapabilityGroup({ label, items }) {
    return (
      <details className="group rounded border border-slate-800 bg-slate-950/30">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-xs text-slate-300">
          <span>{label}</span>
          <span className="rounded bg-slate-800 px-1.5 py-0.5 tabular-nums text-slate-500">{items.length}</span>
        </summary>
        <div className="max-h-48 space-y-1 overflow-auto border-t border-slate-800 px-3 py-2">
          {items.length === 0 ? (
            <p className="text-xs text-slate-600">None detected</p>
          ) : items.map((item) => (
            <div key={item.id} className="flex items-center justify-between gap-3 text-xs">
              <span className={`min-w-0 truncate ${item.enabled ? "text-slate-300" : "text-slate-600"}`}>{item.name}</span>
              <span className="flex-none text-slate-600">
                {!item.enabled && "disabled"}
                {item.version ? `${!item.enabled ? " · " : ""}v${item.version}` : ""}
                {item.transport ? `${!item.enabled || item.version ? " · " : ""}${item.transport}` : ""}
                {!item.version && !item.transport && item.source ? item.source : ""}
              </span>
            </div>
          ))}
        </div>
      </details>
    );
  }

  function ProviderBlock({ provider, stats, refreshToken }) {
    const providerStatus = useProviderStatus(provider.agent, refreshToken);
    const { quota, refreshing, refresh } = useProviderQuota(provider.agent, refreshToken, provider.capabilities?.quota === true);
    const capabilityState = useProviderCapabilities(provider.agent, refreshToken, provider.capabilities?.quota === true || provider.capabilities?.cliUpdate === true);
    const connection = connectionFor(providerStatus, quota);
    const usage = usageForProvider(stats, provider.agent);

    return (
      <Card
        title={provider.label}
        right={<Badge tone={connection.tone}><Dot color={connection.dot} /> {connection.label}</Badge>}
      >
        <div className="space-y-4">
          <section>
            <p className="mb-1 text-xs font-medium text-slate-500">Connection</p>
            <p className={`truncate text-xs ${connection === CONNECTION_BADGES.error ? "text-red-300" : "text-slate-400"}`}>
              {connectionDetail(providerStatus, quota)}
            </p>
          </section>

          <section className="border-t border-slate-800 pt-4">
            <p className="mb-3 text-xs font-medium text-slate-500">Usage</p>
            <UsageSummary usage={usage} loading={stats === null} />
          </section>

          <section className="border-t border-slate-800 pt-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-slate-500">Limits</p>
              <Button variant="ghost" disabled={refreshing} onClick={refresh}>{refreshing ? "Refreshing…" : "Refresh"}</Button>
            </div>
            {quota === null ? (
              <p className="text-xs text-slate-500">Loading limits…</p>
            ) : quota.windows?.length > 0 ? (
              <div className="space-y-3">{quota.windows.map((window) => <QuotaBar key={window.id} window={window} />)}</div>
            ) : (
              <p className="text-xs text-slate-500">{quota.error ?? "No quota windows reported."}</p>
            )}
            {quota?.credits && (
              <p className="mt-3 text-xs text-slate-500">
                Extra usage: {quota.credits.used != null ? `${quota.credits.used} used` : ""}
                {quota.credits.limit != null ? ` of ${quota.credits.limit}` : ""}
                {quota.credits.balance != null ? `${quota.credits.used != null || quota.credits.limit != null ? " · " : ""}${quota.credits.balance} balance` : ""}
                {quota.credits.currency ? ` ${quota.credits.currency}` : ""}
              </p>
            )}
          </section>

          <section className="border-t border-slate-800 pt-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-slate-500">Capabilities</p>
              <Button variant="ghost" disabled={capabilityState.refreshing} onClick={capabilityState.refresh}>
                {capabilityState.refreshing ? "Refreshing…" : "Refresh"}
              </Button>
            </div>
            {capabilityState.capabilities === null ? (
              <p className="text-xs text-slate-500">Loading capabilities…</p>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-500">
                  Driver: {Object.entries(provider.capabilities ?? {}).filter(([, enabled]) => enabled).map(([name]) => name).join(", ") || "none declared"}
                </p>
                <CapabilityGroup label="Plugins" items={capabilityState.capabilities.plugins ?? []} />
                <CapabilityGroup label="Skills" items={capabilityState.capabilities.skills ?? []} />
                <CapabilityGroup label="MCP servers" items={capabilityState.capabilities.mcps ?? []} />
                {capabilityState.capabilities.error && (
                  <p className="text-[11px] text-amber-500/80">Partial inventory: {capabilityState.capabilities.error}</p>
                )}
              </div>
            )}
          </section>
        </div>
      </Card>
    );
  }

  function AIUsageWidget({ refreshToken }) {
    const stats = useStats("day", refreshToken);
    if (stats === null) return <Card title="AI usage"><p className="text-sm text-slate-500">Loading…</p></Card>;
    const usage = {
      outputTokens: stats.totalOutputTokens,
      inputTokens: stats.totalInputTokens,
      cacheCreationTokens: stats.totalCacheCreationTokens,
      cacheReadTokens: stats.totalCacheReadTokens,
      totalCostUsd: stats.totalCostUsd,
      totalDurationMs: stats.totalDurationMs,
      sessionCount: stats.sessionCount,
      rows: [],
    };
    return <Card title="AI usage"><UsageSummary usage={usage} loading={false} /></Card>;
  }

  function AICard({ refreshToken }) {
    const [period, setPeriod] = useState("day");
    const [providers, setProviders] = useState([]);
    const stats = useStats(period, refreshToken);
    useEffect(() => {
      apiGet("/api/v1/models").then(({ body }) => setProviders(body.providers ?? []));
    }, [refreshToken]);
    return (
      <div className="space-y-4">
        <PageHeader
          title="ai"
          subtitle="Provider connection, recorded usage, and account limits"
          right={
            <div className="flex flex-wrap gap-1">
              {PERIODS.map((item) => (
                <Button key={item.id} variant={period === item.id ? "primary" : "ghost"} onClick={() => setPeriod(item.id)}>{item.label}</Button>
              ))}
            </div>
          }
        />
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {providers.map((provider) => (
            <ProviderBlock key={provider.agent} provider={provider} stats={stats} refreshToken={refreshToken} />
          ))}
        </div>
      </div>
    );
  }

  Object.assign(window.ACA, { AICard, AIUsageWidget });
})();
