import { useMemo, useState } from "react";
import { NavLink } from "react-router";
import { useT, type MessageKey } from "../../shared/i18n";
import { FadingTitle } from "../sessions/SessionSidebarList";
import { OPEN, type SignoffStatus, type SignoffSummary, type UnavailablePeon } from "./signoffApi";

type Filter = "mine" | "open" | "all";

export const signoffStatusTone = (status: SignoffStatus): string => {
  switch (status) {
    case "pending":
    case "changes_requested":
      return "text-accent-strong";
    case "approved":
    case "executing":
      return "text-ink-muted";
    case "failed":
    case "interrupted":
    case "partly_done":
      return "text-danger";
    default:
      return "text-ink-faint";
  }
};

export function SignoffSidebarList({ signoffs, unavailable, error, to }: {
  signoffs: SignoffSummary[] | null;
  unavailable: UnavailablePeon[];
  error: boolean;
  to: (signoff: SignoffSummary) => string;
}) {
  const t = useT();
  const [filter, setFilter] = useState<Filter>("mine");
  const rows = useMemo(() => (signoffs ?? []).filter((row) =>
    filter === "all" ? true : filter === "open" ? OPEN.has(row.status) : row.awaitingViewer), [filter, signoffs]);
  // A Peon too old for sign-offs has none to miss; only unreachable ones are named.
  const unreachable = unavailable.filter((peon) => peon.reason !== "unsupported");
  const mine = signoffs?.filter((row) => row.awaitingViewer).length ?? 0;
  return (
    <section>
      <div className="flex gap-1 px-3 py-1.5" role="group" aria-label={t("signoffs.filter")}>
        {(["mine", "open", "all"] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => setFilter(value)}
            className={`rounded px-2 py-0.5 font-body text-[0.6875rem] ${filter === value ? "bg-accent/10 text-accent-strong" : "text-ink-muted hover-wash"}`}
          >
            {t(`signoffs.filter.${value}` as MessageKey)}{value === "mine" && mine > 0 ? ` · ${mine}` : ""}
          </button>
        ))}
      </div>
      {signoffs === null && !error ? (
        <div className="flex min-h-12 items-center justify-center">
          <span className="loading-spinner scale-75" role="status" aria-label={t("signoffs.loading")} />
        </div>
      ) : error && rows.length === 0 ? (
        <p className="px-3 py-2 font-body text-xs text-ink-faint">{t("error.loadFailed")}</p>
      ) : rows.length === 0 ? (
        <p className="px-3 py-2 font-body text-xs text-ink-faint">{t(filter === "mine" ? "signoffs.emptyMine" : "signoffs.empty")}</p>
      ) : (
        <ul className="pb-1">
          {rows.map((row) => (
            <li key={`${row.peonId}:${row.id}`}>
              <NavLink
                to={to(row)}
                className={({ isActive }) => `relative block py-1.5 pl-3 pr-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${isActive ? "bg-accent/10" : "hover-wash"}`}
              >
                <div className="flex min-h-5 items-center gap-2">
                  <span className="flex-none font-body text-[0.6875rem] text-ink-muted">{row.displayNumber}</span>
                  <span className="min-w-0 flex-1 whitespace-nowrap font-body typo-chat-message text-ink"><FadingTitle>{row.title}</FadingTitle></span>
                  {row.awaitingViewer && <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" aria-label={t("signoffs.awaitingYou")} />}
                </div>
                <div className="mt-0.5 flex items-center gap-2 font-body text-[0.6875rem] text-ink-faint">
                  <span className={signoffStatusTone(row.status)}>{t(`signoffs.status.${row.status}` as MessageKey)}</span>
                  <span className="min-w-0 truncate">{row.peonName}{row.projectKey ? ` · ${row.projectKey}` : ""}</span>
                </div>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
      {unreachable.length > 0 && (
        <p className="px-3 py-2 font-body text-[0.6875rem] text-ink-faint">
          {t("signoffs.unavailable", { peons: unreachable.map((peon) => peon.peonName).join(", ") })}
        </p>
      )}
    </section>
  );
}
