import { Check, ChevronDown } from "lucide-react";
import { useNavigate } from "react-router";
import { useT } from "../i18n";
import { useWorkspacePeonPresence } from "../hooks/usePeonPresence";
import { DropdownMenu, menuItemClass } from "../ui";
import { PeonConnectionStatusDot } from "./PeonConnectionStatusDot";

export function PeonScopeSwitcher({ workspaceId, peonId }: { workspaceId: string; peonId?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const peons = useWorkspacePeonPresence(workspaceId);
  const selected = peonId ? peons.find((peon) => peon.peonId === peonId) : undefined;
  const currentLabel = selected?.name || (peonId ? t("peons.unnamed") : t("sessions.allPeons"));

  const choose = (nextPeonId: string, close: () => void) => {
    close();
    navigate(nextPeonId
      ? `/peons/${encodeURIComponent(nextPeonId)}`
      : `/workspaces/${encodeURIComponent(workspaceId)}/sessions`);
  };

  return (
    <DropdownMenu
      label={t("sessions.scope")}
      className="min-w-0 flex-1"
      buttonClassName="flex w-full min-w-0 items-center gap-2 rounded px-0.5 py-1 text-left transition-colors hover:text-accent-strong focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/70"
      menuAlignClassName="left-0"
      menuWidthClassName="w-full min-w-52"
      trigger={(open) => (
        <>
          {selected && <PeonConnectionStatusDot {...selected} />}
          <span className="min-w-0 truncate font-display text-base font-extrabold tracking-wide text-ink" title={currentLabel}>{currentLabel}</span>
          <ChevronDown size={15} className={`flex-none text-ink-muted transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
        </>
      )}
    >
      {(close) => (
        <>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={!peonId}
            className={`${menuItemClass()} !flex items-center gap-2 ${!peonId ? "bg-accent/10 text-accent-strong" : ""}`}
            onClick={() => choose("", close)}
          >
            <span className="w-2 flex-none" />
            <span className="min-w-0 flex-1 truncate">{t("sessions.allPeons")}</span>
            {!peonId && <Check size={14} className="flex-none" aria-hidden />}
          </button>
          <div className="my-1 border-t border-edge" />
          {peons.map((peon) => {
            const active = peon.peonId === peonId;
            return (
              <button
                key={peon.peonId}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`${menuItemClass()} !flex items-center gap-2 ${active ? "bg-accent/10 text-accent-strong" : ""}`}
                onClick={() => choose(peon.peonId, close)}
              >
                <PeonConnectionStatusDot {...peon} />
                <span className="min-w-0 flex-1 truncate">{peon.name || t("peons.unnamed")}</span>
                {active && <Check size={14} className="flex-none" aria-hidden />}
              </button>
            );
          })}
        </>
      )}
    </DropdownMenu>
  );
}
