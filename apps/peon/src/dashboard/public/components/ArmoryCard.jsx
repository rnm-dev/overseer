(function () {
  const { useCallback, useEffect, useRef, useState } = React;
  const { apiGet, apiPost, Badge, Button, List, NavLink, PageHeader, Panel, ProgressBar, Tabs } = window.ACA;

  function ArmoryCard({ subPath, navigate }) {
    const [packageId, tab = "overview"] = subPath ? subPath.split("/") : [];
    return packageId
      ? <PackageDetail packageId={packageId} tab={tab} navigate={navigate} />
      : <PackageList navigate={navigate} />;
  }

  function PackageList({ navigate }) {
    const [state, setState] = useState({ loading: true, refreshing: false, packages: [], registry: null, error: null });
    const requestId = useRef(0);

    const load = useCallback(async (refresh = false) => {
      const currentRequest = ++requestId.current;
      setState((current) => ({
        ...current,
        loading: current.packages.length === 0 && !current.registry,
        refreshing: refresh,
        error: null,
      }));
      let result;
      try {
        result = refresh
          ? await apiPost("/api/v1/armory/refresh")
          : await apiGet("/api/v1/armory/packages?limit=100");
      } catch {
        result = { ok: false, body: { error: "Unable to reach Armory" } };
      }
      if (currentRequest !== requestId.current) return;
      setState((current) => result.ok
        ? {
            loading: false,
            refreshing: false,
            packages: result.body.packages ?? [],
            registry: result.body.registry ?? null,
            error: null,
          }
        : {
            ...current,
            loading: false,
            refreshing: false,
            error: result.body.error ?? "Unable to load Armory",
          });
    }, []);

    useEffect(() => {
      load();
      return () => { requestId.current += 1; };
    }, [load]);

    const registryNotice = state.registry?.source === "cached"
      ? `Showing cached catalog data${state.registry.error?.message ? `: ${state.registry.error.message}` : "."}`
      : state.registry?.source === "unavailable"
        ? state.registry.error?.message ?? "Armory registry is unavailable."
        : null;

    return (
      <div className="space-y-4">
        <PageHeader
          title="Armory"
          subtitle="Installed and available capability packages"
          right={<Button variant="ghost" disabled={state.loading || state.refreshing} onClick={() => load(true)}>{state.refreshing ? "Refreshing…" : "Refresh"}</Button>}
        />
        {state.error && <Panel><p className="text-sm text-red-400">{state.error}</p></Panel>}
        {registryNotice && <Panel><p className={`text-sm ${state.registry.source === "cached" ? "text-amber-400" : "text-red-400"}`}>{registryNotice}</p></Panel>}
        {state.loading ? <Panel><p className="text-sm text-slate-500">Loading packages…</p></Panel> : (
          <List>
            {state.packages.map((pkg) => (
              <li key={pkg.id} className="px-4 py-3">
                <NavLink
                  href={`/settings/armory/${pkg.id}`}
                  onClick={() => navigate(pkg.id)}
                  className="flex items-start justify-between gap-4"
                >
                  <span className="min-w-0">
                    <span className="block font-medium text-slate-100">{pkg.displayName || pkg.id}</span>
                    <span className="mt-1 block text-sm text-slate-500">{pkg.summary || (pkg.installed ? `Installed ${pkg.installed.version}` : pkg.id)}</span>
                  </span>
                  <span className="flex flex-none flex-wrap gap-2">
                    {pkg.capabilities?.mcp && <Badge tone="green">MCP</Badge>}
                    {pkg.updateAvailable && <Badge tone="amber">Update available</Badge>}
                    {pkg.installed && <Badge>{pkg.installed.enabled ? "Enabled" : "Installed"}</Badge>}
                  </span>
                </NavLink>
              </li>
            ))}
            {!state.packages.length && <li className="px-4 py-6 text-sm text-slate-500">
              {state.registry?.source === "unavailable"
                ? "The Armory catalog could not be loaded. Refresh to try again."
                : state.registry?.official
                  ? "The official Armory catalog has no published packages yet."
                  : "No Armory packages found."}
            </li>}
          </List>
        )}
      </div>
    );
  }

  function PackageDetail({ packageId, tab, navigate }) {
    const [detail, setDetail] = useState(null);
    const [mcp, setMcp] = useState(null);
    const [error, setError] = useState(null);
    const [operation, setOperation] = useState(null);
    const [actionError, setActionError] = useState(null);
    const loadDetail = useCallback(async () => {
      const result = await apiGet(`/api/v1/armory/packages/${encodeURIComponent(packageId)}`);
      if (result.ok) { setDetail(result.body); setError(null); }
      else setError(result.body.error ?? "Package not found");
    }, [packageId]);
    useEffect(() => {
      let live = true;
      apiGet(`/api/v1/armory/packages/${encodeURIComponent(packageId)}`).then((result) => {
        if (!live) return;
        if (result.ok) setDetail(result.body);
        else setError(result.body.error ?? "Package not found");
      });
      return () => { live = false; };
    }, [packageId]);
    useEffect(() => {
      if (!operation || operation.status === "success" || operation.status === "failure") return;
      let live = true;
      const poll = async () => {
        const result = await apiGet(`/api/v1/armory/operations/${encodeURIComponent(operation.id)}`);
        if (!live || !result.ok) return;
        const next = result.body.operation;
        setOperation(next);
        if (next.status === "success") await loadDetail();
      };
      const timer = setInterval(poll, 750);
      poll();
      return () => { live = false; clearInterval(timer); };
    }, [operation?.id, operation?.status, loadDetail]);
    useEffect(() => {
      if (tab !== "mcp") return;
      let live = true;
      setMcp(null);
      apiGet(`/api/v1/armory/packages/${encodeURIComponent(packageId)}/mcp`).then((result) => {
        if (live) setMcp(result.ok ? result.body : { error: result.body.error ?? "Unable to inspect MCP" });
      });
      return () => { live = false; };
    }, [packageId, tab]);

    if (error) return <Panel><p className="text-sm text-red-400">{error}</p></Panel>;
    if (!detail) return <Panel><p className="text-sm text-slate-500">Loading package…</p></Panel>;
    const pkg = detail.package;
    const tabs = [
      { id: "overview", label: "Overview", href: `/settings/armory/${packageId}` },
      ...(pkg.capabilities?.mcp ? [{ id: "mcp", label: "MCP", href: `/settings/armory/${packageId}/mcp` }] : []),
    ];
    const active = tab === "mcp" && pkg.capabilities?.mcp ? "mcp" : "overview";
    const startUpdate = async () => {
      setActionError(null);
      const result = await apiPost(`/api/v1/armory/packages/${encodeURIComponent(packageId)}/update`, {});
      if (result.ok) setOperation(result.body.operation);
      else setActionError(result.body.error ?? "Unable to update package");
    };

    return (
      <div className="space-y-4">
        <PageHeader
          title={pkg.displayName || pkg.id}
          subtitle={pkg.summary || pkg.id}
          back={<NavLink href="/settings/armory" onClick={() => navigate("")} className="mb-2 inline-block text-sm text-slate-500 hover:text-slate-200">← Armory</NavLink>}
          right={<>{pkg.capabilities?.mcp && <Badge tone="green">MCP</Badge>}{pkg.updateAvailable && <Button onClick={startUpdate} disabled={operation && operation.status !== "success" && operation.status !== "failure"}>{operation && operation.status !== "success" && operation.status !== "failure" ? "Updating…" : `Update to ${pkg.latestVersion}`}</Button>}</>}
        />
        {actionError && <Panel><p className="text-sm text-red-400">{actionError}</p></Panel>}
        {operation && <Panel><div className="flex items-center justify-between gap-3 text-sm"><span className={operation.status === "failure" ? "text-red-400" : operation.status === "success" ? "text-emerald-400" : "text-slate-300"}>{operation.message}</span><span className="text-slate-500">{operation.progress == null ? "" : `${operation.progress}%`}</span></div>{operation.status !== "failure" && operation.progress != null && <div className="mt-3"><ProgressBar value={operation.progress} /></div>}</Panel>}
        <Tabs tabs={tabs} active={active} onSelect={(id) => navigate(`${packageId}${id === "overview" ? "" : `/${id}`}`)} />
        {active === "overview" ? <Overview pkg={pkg} /> : <McpDetail value={mcp} />}
      </div>
    );
  }

  function Overview({ pkg }) {
    const rows = [
      ["Package ID", pkg.id],
      ["Installed", pkg.installed ? `${pkg.installed.version} · ${pkg.installed.state}` : "No"],
      ["Latest", pkg.latestVersion || "Unavailable"],
      ["Publisher", pkg.publisher || "Unavailable"],
      ["MCP capability", pkg.capabilities?.mcp ? "Yes" : "No"],
    ];
    return <Panel><dl className="grid gap-3 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label}><dt className="text-xs uppercase tracking-wide text-slate-600">{label}</dt><dd className="mt-1 text-sm text-slate-200">{value}</dd></div>)}</dl></Panel>;
  }

  function McpDetail({ value }) {
    if (!value) return <Panel><p className="text-sm text-slate-500">Inspecting MCP tools…</p></Panel>;
    if (value.error) return <Panel><p className="text-sm text-red-400">{value.error}</p></Panel>;
    return (
      <div className="space-y-4">
        <Panel>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={value.running ? "green" : "amber"}>{value.running ? "Running" : value.enabled ? "Unavailable" : "Disabled"}</Badge>
            {value.endpoint && <code className="text-xs text-slate-500">{value.endpoint}</code>}
          </div>
          {!value.running && <p className="mt-3 text-sm text-slate-400">Live tool descriptions are available after the package is configured and enabled.</p>}
        </Panel>
        {value.tools?.length > 0 && <List>{value.tools.map((tool) => (
          <li key={tool.name} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2"><code className="font-medium text-slate-100">{tool.name}</code>{tool.title && <span className="text-sm text-slate-500">{tool.title}</span>}</div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-400">{tool.description || "No description provided."}</p>
            <ParameterList schema={tool.inputSchema} />
          </li>
        ))}</List>}
      </div>
    );
  }

  function ParameterList({ schema }) {
    const entries = Object.entries(schema?.properties ?? {});
    if (!entries.length) return <p className="mt-2 text-xs text-slate-600">No parameters</p>;
    const required = new Set(schema.required ?? []);
    return <div className="mt-3 flex flex-wrap gap-2">{entries.map(([name, value]) => <Badge key={name} title={value?.description}>{name}{required.has(name) ? " *" : ""}{value?.type ? ` · ${value.type}` : ""}</Badge>)}</div>;
  }

  window.ACA.ArmoryCard = ArmoryCard;
})();
