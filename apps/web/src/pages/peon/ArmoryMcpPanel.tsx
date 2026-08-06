import { Badge, Button, Card } from "../../ui";
import type { ArmoryMcpDetails, ArmoryMcpInputProperty, ArmoryMcpTool } from "./armoryApi";

function propertyType(property: ArmoryMcpInputProperty): string {
  if (Array.isArray(property.type)) return property.type.join(" | ");
  return property.type || "unspecified";
}

export function discoveredTools(details: ArmoryMcpDetails): ArmoryMcpTool[] {
  return details.tools ?? details.discovery?.tools ?? details.discovery?.result?.tools ?? [];
}

export function ArmoryMcpPanel({ details, loading, error, configured, enabled, assignmentManaged = false, onRetry }: {
  details: ArmoryMcpDetails | null;
  loading: boolean;
  error: unknown;
  configured: boolean;
  enabled: boolean;
  assignmentManaged?: boolean;
  onRetry: () => void;
}) {
  if (loading) return <div className="grid min-h-40 place-items-center" aria-label="Loading MCP details"><div className="loading-spinner" /></div>;

  const status = details?.runtime?.status ?? details?.status ?? (!enabled ? "disabled" : "unavailable");
  const tools = details ? discoveredTools(details) : [];
  const discoveryPending = assignmentManaged ? status !== "running" : status !== "running" || !configured || !enabled;
  const unavailableMessage = assignmentManaged
    ? "Tools are available only in projects where this package is assigned. Assignment changes apply to subsequent turns."
    : !configured
    ? "Configure and enable this package to see its available tools."
    : !enabled
      ? "Enable this package to see its available tools."
      : "Tool information is currently unavailable. Try again in a moment.";

  return (
    <div className="space-y-3">
      {discoveryPending && tools.length === 0 ? (
        <Card className="p-6 text-center">
          <h3 className="font-display text-base font-bold text-ink">Tools aren’t available yet</h3>
          <p className="mx-auto mt-2 max-w-2xl text-sm leading-relaxed text-ink-muted">{unavailableMessage}</p>
        </Card>
      ) : error && !details ? (
        <div role="alert" className="flex flex-wrap items-center justify-between gap-3 border-l-2 border-danger bg-danger/5 px-4 py-3 text-sm text-danger">
          <span>MCP details could not be loaded: {error instanceof Error ? error.message : "Unknown error"}</span>
          <Button type="button" size="sm" variant="secondary" onClick={onRetry}>Retry</Button>
        </div>
      ) : tools.length === 0 ? (
        <Card className="p-6 text-center text-sm text-ink-muted">The live MCP server currently exposes no tools.</Card>
      ) : (
        <section className="space-y-2" aria-label="Exposed MCP tools">
          <div className="flex items-center justify-between gap-3"><h3 className="font-display text-base font-bold text-ink">Exposed tools</h3><span className="font-mono text-[0.7rem] text-ink-faint">{tools.length} tool{tools.length === 1 ? "" : "s"}</span></div>
          {tools.map((tool) => {
            const properties = Object.entries(tool.inputSchema?.properties ?? {});
            const required = new Set(tool.inputSchema?.required ?? []);
            return <Card key={tool.name} className="overflow-hidden">
              <details className="group">
                <summary className="cursor-pointer list-none px-4 py-3 marker:hidden [&::-webkit-details-marker]:hidden">
                  <div className="flex min-w-0 items-start gap-3">
                    <span className="mt-0.5 shrink-0 font-mono text-xs text-ink-faint transition-transform group-open:rotate-90" aria-hidden>›</span>
                    <div className="min-w-0">
                      <h4 className="break-all font-mono text-sm font-bold leading-5 text-accent-strong">{tool.name}</h4>
                      <p className="mt-0.5 whitespace-pre-wrap text-xs leading-5 text-ink-muted">{tool.description || "No description returned by MCP discovery."}</p>
                    </div>
                  </div>
                </summary>
                <div className="border-t border-edge-strong/70 px-4 py-3"><h5 className="font-display text-[0.68rem] font-bold uppercase tracking-wider text-ink-faint">Input properties</h5>
                  {properties.length === 0 ? <p className="mt-1.5 text-xs text-ink-muted">No input properties.</p> : <dl className="mt-1 divide-y divide-edge">{properties.map(([name, property]) => <div key={name} className="grid gap-0.5 py-2 sm:grid-cols-[minmax(8rem,0.7fr)_minmax(0,2fr)] sm:gap-3"><dt className="min-w-0"><span className="break-all font-mono text-xs text-ink">{name}</span><span className="ml-2 font-mono text-[0.6rem] uppercase text-ink-faint">{propertyType(property)}</span>{required.has(name) && <Badge tone="amber">Required</Badge>}</dt><dd className="text-xs leading-5 text-ink-muted">{property.description || "No description returned."}</dd></div>)}</dl>}
                </div>
              </details>
            </Card>;
          })}
        </section>
      )}
    </div>
  );
}
