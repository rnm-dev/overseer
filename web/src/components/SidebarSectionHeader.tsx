import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

// author: Viktor
// The sidebar chrome showcased in the instructions site's collaboration card:
// a tinted full-bleed section bar with a small-caps label, and rows whose
// status reads off a glowing left edge instead of a dot. Kept here so the
// dashboard sidebar and the site stay pixel-identical.

export const SIDEBAR_SECTION_HEADER_CLASS =
  "flex items-center gap-1 bg-bone/5 px-3 py-1.5 font-display text-[0.55rem] uppercase tracking-[0.16em] text-bone-faint";

export const SIDEBAR_SECTION_ACTION_CLASS = "uppercase text-bone-dim transition-colors hover:text-fel-bright";

export const SIDEBAR_ROW_EDGE_CLASS = "absolute inset-y-1 left-0 w-0.5";

export const SIDEBAR_ROW_EDGE_IDLE_CLASS = "bg-bone-faint/40";

export const SIDEBAR_ROW_EDGE_FLASH_CLASS = "status-edge-flash";

export interface RowFingerprint {
  key: string;
  fingerprint: string;
}

export function changedRowKeys(seen: Map<string, string>, current: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [key, fingerprint] of current) {
    if (seen.get(key) !== fingerprint) changed.push(key);
  }
  return changed;
}

// Every row a live update touches gets a fresh nonce; the caller feeds it into
// the edge's React key, so the element remounts and replays the one-shot flash.
// The first pass only adopts the fingerprints — arriving at a populated list is
// not news, and flashing the whole sidebar on mount would be noise.
export function useRowUpdateFlashes(rows: RowFingerprint[]): Map<string, number> {
  const seen = useRef<Map<string, string> | null>(null);
  const [flashes, setFlashes] = useState<Map<string, number>>(new Map());
  // Separators no key or fingerprint can contain, so two different row sets
  // never collapse into one signature and silently swallow a flash.
  const signature = rows.map((row) => `${row.key}\u0000${row.fingerprint}`).join("\u0001");

  useEffect(() => {
    const current = new Map(rows.map((row) => [row.key, row.fingerprint]));
    const previous = seen.current;
    seen.current = current;
    if (!previous) return;
    const changed = changedRowKeys(previous, current);
    const dropped = [...previous.keys()].some((key) => !current.has(key));
    if (!changed.length && !dropped) return;
    setFlashes((currentFlashes) => {
      const next = new Map(currentFlashes);
      for (const key of changed) next.set(key, (next.get(key) ?? 0) + 1);
      for (const key of [...next.keys()]) if (!current.has(key)) next.delete(key);
      return next;
    });
    // The signature carries every row identity and fingerprint this effect reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return flashes;
}

export function rowEdgeClass(status: string, flash: number | undefined): string {
  return `${SIDEBAR_ROW_EDGE_CLASS} ${status}${flash ? ` ${SIDEBAR_ROW_EDGE_FLASH_CLASS}` : ""}`;
}

export function SidebarSectionHeader({
  label,
  action,
  expanded,
  onToggle,
  controls,
}: {
  label: ReactNode;
  action?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  controls?: string;
}) {
  return (
    <div className={SIDEBAR_SECTION_HEADER_CLASS}>
      {onToggle ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={controls}
          className="flex min-w-0 items-center gap-1 uppercase transition-colors hover:text-bone"
          onClick={onToggle}
        >
          {expanded ? <ChevronDown size={10} aria-hidden /> : <ChevronRight size={10} aria-hidden />}
          <span className="truncate">{label}</span>
        </button>
      ) : (
        <span className="min-w-0 truncate uppercase">{label}</span>
      )}
      {action && <span className="ml-auto flex-none uppercase">{action}</span>}
    </div>
  );
}
