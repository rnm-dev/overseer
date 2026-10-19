import { Badge } from "../../shared/ui";
import { useT } from "../../shared/i18n";
import type { CapabilitiesState, CapabilityItem } from "./statsModel";

export function CapabilitiesInventory({ state }: { state: CapabilitiesState }) {
  const t = useT();
  const inventory = state.data;
  const groups: Array<{ key: "plugins" | "skills" | "mcps"; items: CapabilityItem[] }> = [
    { key: "plugins", items: inventory?.plugins ?? [] },
    { key: "skills", items: inventory?.skills ?? [] },
    { key: "mcps", items: inventory?.mcps ?? [] },
  ];
  const hasItems = groups.some((group) => group.items.length > 0);
  const inventoryError = state.error ?? inventory?.error ?? null;
  const partial = Boolean(inventoryError && hasItems);

  return (
    <section className="mt-5 border-t border-edge pt-4">
      <div className="mb-2 font-display text-[0.6rem] uppercase tracking-[0.16em] text-ink-muted">
        {t("peon.capabilities.inventory")}
      </div>
      {state.loading && !inventory ? (
        <div className="loading-spinner" />
      ) : (
        <>
          {inventoryError && (
            <p className={`mb-3 border-l-2 pl-3 font-mono text-xs ${partial ? "border-warning text-warning" : "border-danger text-danger"}`}>
              {partial ? `${t("peon.capabilities.partial")}: ` : ""}{inventoryError}
            </p>
          )}
          {groups.map((group) => (
            <CapabilityGroup key={group.key} label={t(`peon.capabilities.${group.key}`)} items={group.items} />
          ))}
        </>
      )}
    </section>
  );
}

function CapabilityGroup({ label, items }: { label: string; items: CapabilityItem[] }) {
  const t = useT();
  return (
    <details className="border-t border-edge first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 font-display text-xs font-medium text-ink marker:hidden">
        <span>{label}</span>
        <span className="rounded-sm bg-surface-raised px-2 py-0.5 font-mono text-[0.68rem] text-ink-muted">{items.length}</span>
      </summary>
      {items.length === 0 ? (
        <p className="pb-3 font-mono text-xs text-ink-faint">{t("peon.capabilities.empty")}</p>
      ) : (
        <ul className="divide-y divide-edge pb-2">
          {items.map((item) => (
            <li key={item.id} className="py-2.5">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words font-mono text-xs text-ink">{item.name}</span>
                <Badge tone={item.enabled ? "green" : "neutral"}>
                  {t(item.enabled ? "peon.capabilities.enabled" : "peon.capabilities.disabled")}
                </Badge>
              </div>
              {(item.version || item.source || item.transport) && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[0.68rem] text-ink-faint">
                  {item.version && <span>{t("peon.capabilities.version")}: {item.version}</span>}
                  {item.source && <span>{t("peon.capabilities.source")}: {item.source}</span>}
                  {item.transport && <span>{t("peon.capabilities.transport")}: {item.transport}</span>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
