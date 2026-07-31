import type { ReactNode } from "react";
import { NavLink } from "react-router";

export interface RouteTab {
  to: string;
  label: ReactNode;
  end?: boolean;
}

export function RouteTabs({
  ariaLabel,
  tabs,
  className = "",
}: {
  ariaLabel: string;
  tabs: RouteTab[];
  className?: string;
}) {
  return (
    <nav
      className={`flex overflow-x-auto border-b border-edge-strong ${className}`}
      aria-label={ariaLabel}
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            `shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 font-display text-sm font-bold transition-colors ${
              isActive
                ? "border-accent text-accent-strong"
                : "border-transparent text-ink-muted hover:text-ink"
            }`
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
