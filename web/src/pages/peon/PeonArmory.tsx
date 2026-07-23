import { useCallback, useEffect, useRef, useState } from "react";
import { Cpu, ExternalLink, Package as PackageIcon, RefreshCw, Search } from "lucide-react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../../api";
import { Badge, Button, Card } from "../../ui";
import { usePeon } from "./context";
import { ArmoryConfigurationPanel } from "./ArmoryConfigurationPanel";
import { ArmoryMcpPanel } from "./ArmoryMcpPanel";
import { ArmoryLifecyclePanel } from "./ArmoryLifecyclePanel";
import {
  ARMORY_SEARCH_DEBOUNCE_MS,
  activeArmoryCapabilities,
  ArmoryRequestGate,
  getArmoryConfiguration,
  getArmoryInventory,
  getArmoryMcp,
  getArmoryPackage,
  getArmorySettings,
  isMcpCapable,
  refreshArmory,
  type ArmoryConfiguration,
  type ArmoryInventoryResponse,
  type ArmoryMcpDetails,
  type ArmoryPackageDetailResponse,
  type ArmoryPackageSummary,
  type ArmoryRegistry,
  type ArmorySettings,
  type ArmoryView,
} from "./armoryApi";

function ErrorNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const candidate = error as Partial<ApiError> | null;
  const message = error instanceof Error ? error.message : "Armory data could not be loaded.";
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-blood bg-blood/5 px-4 py-3 font-mono text-sm text-blood">
      <span>⚠ {message}{candidate?.code ? <span className="ml-2 text-xs opacity-75">({candidate.code})</span> : null}</span>
      {retry && <Button type="button" size="sm" variant="iron" onClick={retry}>Retry</Button>}
    </div>
  );
}

function formatDate(value: number | string | null | undefined): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString();
}

function safeUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch { return null; }
}

function RegistryNotices({ registry, settings }: { registry: ArmoryRegistry; settings: ArmorySettings | null }) {
  const overridden = settings?.registryOverridden || !registry.official;
  return (
    <div className="space-y-2">
      {overridden && (
        <p className="border-l-2 border-forge bg-forge/5 px-4 py-3 font-mono text-sm text-ember">
          Non-default Armory registry in use: {safeUrl(settings?.effectiveRegistryUrl || registry.url) ?? "custom registry"}.
        </p>
      )}
      {registry.source === "unavailable" && (
        <p className="border-l-2 border-forge bg-forge/5 px-4 py-3 font-mono text-sm text-ember">
          Registry unavailable{registry.error?.message ? `: ${registry.error.message}` : "."} Installed package records remain available.
          {registry.error?.code && <span className="ml-2 text-xs opacity-75">({registry.error.code})</span>}
        </p>
      )}
    </div>
  );
}

type RefreshState = "idle" | "refreshing" | "success" | "error";

function RegistryRefresh({ registry, state, checkedAt, onRefresh }: { registry: ArmoryRegistry; state: RefreshState; checkedAt: number | null; onRefresh: () => void }) {
  const label = state === "refreshing" ? "Refreshing" : state === "success" ? "Updated" : state === "error" ? "Retry" : "Refresh";
  const tone = state === "success" ? "text-fel-bright" : state === "error" ? "text-blood" : "text-bone-dim hover:text-bone";
  const status = checkedAt ? `Checked · ${formatDate(checkedAt)}` : `${registry.source === "cached" ? "Cached" : "Updated"} · ${formatDate(registry.fetchedAt)}`;
  return (
    <div className="flex h-11 items-center gap-2 rounded-md border border-iron-700 bg-iron-950/80 pl-3 pr-1">
      <span className={`whitespace-nowrap font-mono text-[0.68rem] ${registry.source === "cached" ? "text-ember" : "text-bone-faint"}`} title="Catalog refresh status">
        {status}
      </span>
      <button type="button" disabled={state === "refreshing"} onClick={onRefresh} className={`inline-flex h-9 items-center gap-1.5 rounded px-2.5 font-display text-xs font-bold transition-colors hover:bg-iron-800 disabled:cursor-wait ${tone}`} aria-live="polite">
        <RefreshCw size={14} className={state === "refreshing" ? "animate-spin" : ""} aria-hidden />
        {label}
      </button>
    </div>
  );
}

function CapabilityChips({ item }: { item: ArmoryPackageSummary }) {
  const capabilities = activeArmoryCapabilities(item);
  if (!capabilities.length) return null;
  return <div className="flex flex-wrap gap-1.5">{capabilities.map((capability) => <Badge key={capability} tone="green">{capability.toUpperCase()}</Badge>)}</div>;
}

function PackageBadges({ item }: { item: ArmoryPackageSummary }) {
  if (!item.installed) return item.updateAvailable ? <Badge tone="amber">Update available</Badge> : null;
  const installed = item.installed;
  const hasError = installed.state === "error" || installed.configurationStatus === "invalid" || Boolean(installed.lastError);
  const needsConfiguration = !hasError && (installed.state === "needs_configuration" || installed.configurationStatus === "missing");
  const disabled = !hasError && !needsConfiguration && !installed.enabled;
  if (!hasError && !needsConfiguration && !disabled && !item.updateAvailable) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {needsConfiguration && <Badge tone="amber">Needs config</Badge>}
      {hasError && <Badge tone="red">Error</Badge>}
      {disabled && <Badge tone="amber">Disabled</Badge>}
      {item.updateAvailable && <Badge tone="amber">Update available</Badge>}
    </div>
  );
}

export function isPackageReady(item: ArmoryPackageSummary): boolean {
  const installed = item.installed;
  return Boolean(
    installed
    && installed.enabled
    && installed.state === "ready"
    && (installed.configurationStatus === "verified" || installed.configurationStatus === "not_required")
    && !installed.lastError,
  );
}

export function PackageCard({ item }: { item: ArmoryPackageSummary }) {
  const ready = isPackageReady(item);
  const icon = safeUrl(item.iconUrl || item.icon);
  return (
    <li>
      <Link to={encodeURIComponent(item.id)} className="block h-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-fel">
        <Card className={`relative flex h-full flex-col overflow-hidden p-5 transition-all hover:border-fel/40 hover:bg-fel/[0.025] ${ready ? "border-fel/35 bg-fel/[0.045] shadow-[inset_0_1px_0_rgba(149,201,103,0.08),0_0_28px_rgba(86,136,55,0.06)]" : ""}`}>
          {ready && <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-fel-bright/70 to-transparent" aria-hidden />}
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md border border-iron-700 bg-iron-900 text-bone-faint">{icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : <PackageIcon size={19} aria-hidden />}</div>
              <div className="min-w-0">
              <h2 className="truncate font-display text-base font-bold text-bone">{item.displayName || item.id}</h2>
              {item.displayName && <p className="mt-0.5 truncate font-mono text-[0.68rem] text-bone-faint">{item.id}</p>}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <PackageBadges item={item} />
              <div className="relative grid size-9 place-items-center" role="img" aria-label={ready ? "Installed and running" : item.installed ? "Installed but not running" : "Not installed"}>
                {ready && <Cpu className="absolute animate-pulse text-fel blur-[5px] motion-reduce:animate-none" size={22} strokeWidth={3} aria-hidden />}
                <Cpu className={ready ? "relative z-10 text-fel-bright drop-shadow-[0_0_6px_rgba(143,239,63,0.95)]" : "relative z-10 text-iron-500"} size={20} strokeWidth={2.2} aria-hidden />
              </div>
            </div>
          </div>
          <p className="mt-3 line-clamp-3 flex-1 text-sm leading-relaxed text-bone-dim">{item.summary || (item.available ? "No description provided." : "This installed package is no longer present in the current catalog.")}</p>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 font-mono text-[0.7rem] text-bone-faint">
            <CapabilityChips item={item} />
            <span className={ready ? "text-fel-bright/80" : ""}>{ready ? `Enabled · ${item.installed?.version}` : item.installed ? `${item.installed.enabled ? "Enabled" : "Disabled"} · ${item.installed.version}` : "Not installed"}{item.latestVersion && !ready ? ` · Latest ${item.latestVersion}` : ""}</span>
          </div>
        </Card>
      </Link>
    </li>
  );
}

function MarketplaceList() {
  const { peon, base } = usePeon();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [view, setView] = useState<ArmoryView>("available");
  const [inventory, setInventory] = useState<ArmoryInventoryResponse | null>(null);
  const [settings, setSettings] = useState<ArmorySettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshState, setRefreshState] = useState<RefreshState>("idle");
  const [lastCheckedAt, setLastCheckedAt] = useState<number | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const refreshController = useRef<AbortController | null>(null);
  const gate = useRef(new ArmoryRequestGate());
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query), ARMORY_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (cursor: string | null = null, append = false) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const token = gate.current.begin();
    if (append) setLoadingMore(true);
    else setLoading(true);
    if (!append) setError(null);
    try {
      const result = await getArmoryInventory(base, { q: debouncedQuery, view, cursor }, (path) => api(path, { signal: abort.signal }));
      if (!gate.current.current(token)) return;
      setInventory((previous) => append && previous ? { ...result, packages: [...previous.packages, ...result.packages] } : result);
      setError(null);
    } catch (err) {
      if (!abort.signal.aborted && gate.current.current(token)) setError(err);
    } finally {
      if (gate.current.current(token)) { setLoading(false); setLoadingMore(false); }
    }
  }, [base, debouncedQuery, view]);

  useEffect(() => {
    const requestGate = gate.current;
    setInventory(null);
    setError(null);
    if (!peon.online) { setLoading(false); return () => requestGate.clear(); }
    void load();
    return () => { controller.current?.abort(); requestGate.clear(); };
  }, [load, peon.online]);

  useEffect(() => {
    let active = true;
    getArmorySettings(base).then((value) => { if (active) setSettings(value); }).catch(() => { if (active) setSettings(null); });
    return () => { active = false; setSettings(null); };
  }, [base]);

  useEffect(() => () => {
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshController.current?.abort();
  }, []);

  const refreshCatalog = useCallback(async () => {
    if (refreshState === "refreshing") return;
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshController.current?.abort();
    const abort = new AbortController();
    refreshController.current = abort;
    controller.current?.abort();
    gate.current.clear();
    setLoading(false);
    setRefreshState("refreshing");
    try {
      const request = <T,>(path: string, options?: RequestInit) => api<T>(path, { ...options, signal: abort.signal });
      await refreshArmory(base, request);
      let refreshed: ArmoryInventoryResponse | null = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, attempt === 0 ? 250 : 500));
        if (abort.signal.aborted) return;
        const result = await getArmoryInventory(base, { q: debouncedQuery, view }, request);
        if (result.registry.source !== "unavailable" && (result.packages.length > 0 || view === "installed")) {
          refreshed = result;
          break;
        }
      }
      if (refreshed) setInventory(refreshed);
      setError(null);
      setLastCheckedAt(Date.now());
      setRefreshState("success");
      refreshTimer.current = window.setTimeout(() => setRefreshState("idle"), 2000);
    } catch {
      if (!abort.signal.aborted) setRefreshState("error");
    }
  }, [base, debouncedQuery, refreshState, view]);

  const unavailableEmpty = inventory?.registry.source === "unavailable" && inventory.packages.length === 0;
  const officialEmpty = inventory?.total === 0 && view === "available" && !debouncedQuery && inventory.registry.source !== "unavailable" && inventory.registry.official;
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-iron-800 pb-5">
        <div><h1 className="font-display text-2xl font-extrabold text-bone">Armory</h1><p className="mt-1 font-mono text-xs text-bone-dim">Packages for {peon.name || peon.hostname || peon.peonId}</p></div>
        {inventory && <span className="rounded-full border border-iron-700 bg-iron-900 px-3 py-1 font-mono text-[0.7rem] text-bone-dim">{inventory.total} package{inventory.total === 1 ? "" : "s"}</span>}
      </header>

      {!peon.online && <p className="border-l-2 border-blood bg-blood/5 px-4 py-3 font-mono text-sm text-blood">This Peon is offline — Armory data is unavailable.</p>}
      <div className="surface flex flex-col gap-2.5 p-2.5 lg:flex-row">
        <label className="group relative min-w-0 flex-1">
          <span className="sr-only">Search packages</span>
          <Search className="pointer-events-none absolute left-3.5 top-1/2 z-10 -translate-y-1/2 text-bone-faint transition-colors group-focus-within:text-fel-bright" size={17} aria-hidden />
          <input className="field !h-11 !rounded-md !border-iron-700 !bg-iron-950/80 !py-0 !pl-11 !pr-4 text-sm" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search packages" type="search" />
        </label>
        <div className="inline-flex h-11 shrink-0 rounded-md border border-iron-700 bg-iron-950/80 p-1" role="group" aria-label="Package view">
          {(["available", "installed"] as const).map((option) => <button key={option} type="button" aria-pressed={view === option} onClick={() => setView(option)} className={`rounded px-4 font-display text-xs font-bold capitalize transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-fel ${view === option ? "bg-fel text-fel-ink shadow-sm" : "text-bone-dim hover:bg-iron-800 hover:text-bone"}`}>{option}</button>)}
        </div>
        {inventory && <RegistryRefresh registry={inventory.registry} state={refreshState} checkedAt={lastCheckedAt} onRefresh={() => void refreshCatalog()} />}
      </div>

      {inventory && <RegistryNotices registry={inventory.registry} settings={settings} />}
      {Boolean(error) && <ErrorNotice error={error} retry={() => void load()} />}
      {unavailableEmpty && !error && <ErrorNotice error={new ApiError(503, inventory.registry.error?.code || "REGISTRY_UNAVAILABLE", inventory.registry.error?.message || "The Armory registry is unavailable.")} retry={() => void load()} />}

      {loading && !inventory ? <div className="grid min-h-48 place-items-center"><div className="forge-spin" /></div> : officialEmpty ? (
        <Card className="px-6 py-12 text-center"><h2 className="font-display text-base text-bone">The official catalog is empty</h2><p className="mt-2 text-sm text-bone-dim">There are currently no published Armory packages.</p></Card>
      ) : inventory?.packages.length === 0 && !unavailableEmpty ? (
        <Card className="px-6 py-12 text-center"><p className="text-sm text-bone-dim">No packages match this {view} view{debouncedQuery ? " and search" : ""}.</p></Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2">{inventory?.packages.map((item) => <PackageCard key={item.id} item={item} />)}</ul>
      )}

      {inventory?.nextCursor && <div className="flex justify-center"><Button type="button" variant="iron" disabled={loadingMore} onClick={() => void load(inventory.nextCursor, true)}>{loadingMore ? "Loading…" : "Load more"}</Button></div>}

    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="font-mono text-xs text-bone-faint">{label}</dt><dd className="mt-1 text-sm text-bone">{children}</dd></div>;
}

function PackageDetail({ packageId }: { packageId: string }) {
  const { peon, base } = usePeon();
  const [detail, setDetail] = useState<ArmoryPackageDetailResponse | null>(null);
  const [configuration, setConfiguration] = useState<ArmoryConfiguration | null>(null);
  const [mcp, setMcp] = useState<ArmoryMcpDetails | null>(null);
  const [mcpError, setMcpError] = useState<unknown>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [tab, setTab] = useState<"overview" | "mcp">("overview");
  const [error, setError] = useState<unknown>(null);
  const [configurationError, setConfigurationError] = useState<unknown>(null);
  const gate = useRef(new ArmoryRequestGate());
  const controller = useRef<AbortController | null>(null);
  const load = useCallback(async (quiet = false) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    const token = gate.current.begin();
    if (!quiet) { setDetail(null); setConfiguration(null); setMcp(null); setError(null); }
    setConfigurationError(null);
    setMcpError(null);
    try {
      const request = <T,>(path: string) => api<T>(path, { signal: abort.signal });
      const value = await getArmoryPackage(base, packageId, request);
      if (!gate.current.current(token)) return;
      setDetail(value);
      const mcpCapable = isMcpCapable(value.package) || isMcpCapable(value.catalog);
      if (mcpCapable) {
        setMcpLoading(true);
        try { const result = await getArmoryMcp(base, packageId, request); if (gate.current.current(token)) setMcp(result); }
        catch (err) { if (!abort.signal.aborted && gate.current.current(token)) setMcpError(err); }
        finally { if (gate.current.current(token)) setMcpLoading(false); }
      } else {
        setMcp(null);
        setMcpLoading(false);
        setTab("overview");
      }
      if (value.package.installed) {
        try { const config = await getArmoryConfiguration(base, packageId, request); if (gate.current.current(token)) setConfiguration(config); }
        catch (err) { if (!abort.signal.aborted && gate.current.current(token)) setConfigurationError(err); }
      } else setConfiguration(null);
    } catch (err) { if (!abort.signal.aborted && gate.current.current(token)) setError(err); }
  }, [base, packageId]);
  const refresh = useCallback(() => load(true), [load]);
  useEffect(() => {
    const requestGate = gate.current;
    if (peon.online) void load();
    return () => { controller.current?.abort(); requestGate.clear(); };
  }, [load, peon.online]);

  if (!peon.online) return <div className="space-y-4"><Link to=".." relative="path" className="font-mono text-xs text-bone-dim hover:text-fel-bright">← Armory</Link><p className="border-l-2 border-blood bg-blood/5 px-4 py-3 font-mono text-sm text-blood">This Peon is offline — Armory data is unavailable.</p></div>;
  if (error) return <div className="space-y-4"><Link to=".." relative="path" className="font-mono text-xs text-bone-dim hover:text-fel-bright">← Armory</Link><ErrorNotice error={error} retry={() => void load()} /></div>;
  if (!detail) return <div className="grid min-h-48 place-items-center"><div className="forge-spin" /></div>;
  const item = detail.package; const catalog = detail.catalog; const docs = safeUrl(catalog?.documentationUrl || item.documentationUrl);
  const icon = safeUrl(catalog?.iconUrl || catalog?.icon || item.iconUrl || item.icon);
  const mcpCapable = isMcpCapable(item) || isMcpCapable(catalog);
  const configured = item.installed?.configurationStatus === "not_required" || item.installed?.configurationStatus === "verified";
  return (
    <div className="space-y-6">
      <Link to=".." relative="path" className="font-mono text-xs text-bone-dim hover:text-fel-bright">← Armory</Link>
      <RegistryNotices registry={detail.registry} settings={null} />
      <header><div className="flex flex-wrap items-start justify-between gap-4"><div className="flex items-center gap-3"><div className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-lg border border-iron-700 bg-iron-900 text-bone-faint">{icon ? <img src={icon} alt="" className="h-full w-full object-cover" /> : <PackageIcon size={23} aria-hidden />}</div><div><h1 className="font-display text-2xl font-extrabold text-bone">{catalog?.displayName || item.displayName || item.id}</h1><p className="mt-1 font-mono text-xs text-bone-faint">{item.id} · {peon.name || peon.hostname || peon.peonId}</p></div></div><div className="flex flex-wrap gap-1.5"><CapabilityChips item={item} /><PackageBadges item={item} /></div></div><p className="mt-4 max-w-3xl text-sm leading-relaxed text-bone-dim">{catalog?.summary || item.summary || "Catalog metadata is unavailable for this installed package."}</p>{docs && <a className="mt-3 inline-flex items-center gap-1.5 font-mono text-xs text-fel-bright hover:underline" href={docs} target="_blank" rel="noreferrer">Documentation <ExternalLink size={13} /></a>}</header>
      {mcpCapable && <div className="flex border-b border-iron-700" role="tablist" aria-label="Package details"><button type="button" role="tab" aria-selected={tab === "overview"} onClick={() => setTab("overview")} className={`border-b-2 px-4 py-2 font-display text-sm font-bold ${tab === "overview" ? "border-fel text-fel-bright" : "border-transparent text-bone-dim hover:text-bone"}`}>Overview</button><button type="button" role="tab" aria-selected={tab === "mcp"} onClick={() => setTab("mcp")} className={`border-b-2 px-4 py-2 font-display text-sm font-bold ${tab === "mcp" ? "border-fel text-fel-bright" : "border-transparent text-bone-dim hover:text-bone"}`}>MCP</button></div>}
      {tab === "mcp" && mcpCapable ? <ArmoryMcpPanel details={mcp} loading={mcpLoading} error={mcpError} configured={Boolean(configured)} enabled={Boolean(item.installed?.enabled)} onRetry={() => void refresh()} /> : <>
        <ArmoryLifecyclePanel base={base} packageId={packageId} installed={item.installed} versions={catalog?.versions ?? []} latestVersion={catalog?.latest || item.latestVersion} updateAvailable={item.updateAvailable} onRefresh={refresh} />
        <Card className="p-5"><dl className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4"><DetailRow label="Latest version">{catalog?.latest || item.latestVersion || "Unavailable"}</DetailRow><DetailRow label="Installed version">{item.installed?.version || "Not installed"}</DetailRow><DetailRow label="Configuration">{item.installed?.configurationStatus?.replace(/_/g, " ") || "Not installed"}</DetailRow><DetailRow label="Credentials required">{(catalog?.requirements || item.requirements)?.credentials ? "Yes" : "No"}</DetailRow><DetailRow label="Host writes required">{(catalog?.requirements || item.requirements)?.hostWrites ? "Yes" : "No"}</DetailRow>{item.installed && <><DetailRow label="Installed">{formatDate(item.installed.installedAt)}</DetailRow><DetailRow label="Updated">{formatDate(item.installed.updatedAt)}</DetailRow></>}</dl>{item.installed?.lastError && <p className="mt-5 border-l-2 border-blood bg-blood/5 px-3 py-2 text-sm text-blood">The latest package operation failed.</p>}</Card>
        <section><h2 className="mb-3 font-display text-lg font-bold text-bone">Catalog versions</h2>{!catalog ? <Card className="p-5 text-sm text-bone-dim">This is an installed-only package. It is not present in the current catalog.</Card> : <div className="space-y-3">{catalog.versions.map((version) => <Card key={version.version} className="p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-display text-sm font-bold text-bone">Version {version.version}</h3><span className="font-mono text-xs text-bone-faint">Requires Peon {version.minPeonVersion}+</span></div><div className="mt-3 flex flex-wrap gap-2">{version.platforms.map((platform) => <Badge key={`${platform.os}-${platform.arch}`}>{platform.os} / {platform.arch}</Badge>)}</div><details className="mt-3 text-xs text-bone-faint"><summary className="cursor-pointer font-mono">Technical archive details</summary><dl className="mt-2 space-y-1 font-mono"><div className="break-all">URL: {safeUrl(version.archive.url) ?? "Unavailable"}</div><div>Size: {version.archive.size.toLocaleString()} bytes</div><div className="break-all">SHA-256: {version.archive.sha256}</div></dl></details></Card>)}</div>}</section>
        <ArmoryConfigurationPanel key={`${base}:${packageId}`} base={base} packageId={packageId} installed={item.installed} schema={configuration} schemaError={configurationError} onRetrySchema={() => void refresh()} onRefresh={refresh} />
      </>}
    </div>
  );
}

export function PeonArmory() {
  const { packageId } = useParams();
  return packageId ? <PackageDetail packageId={packageId} /> : <MarketplaceList />;
}
