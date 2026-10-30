import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { NavLink } from "react-router";
import { TOOLBAR_GROUP, toolbarItemClass } from "./ui";

export interface RouteTab {
  to: string;
  label: ReactNode;
  icon?: LucideIcon;
  end?: boolean;
}

// "bar" is the underlined strip under a page header; "header" is the compact
// form that sits inside a top bar, where labels collapse to icons on narrow
// desktops.
export function RouteTabs({
  ariaLabel,
  tabs,
  className = "",
  variant = "bar",
}: {
  ariaLabel: string;
  tabs: RouteTab[];
  className?: string;
  variant?: "bar" | "header";
}) {
  const header = variant === "header";
  return (
    <nav
      className={`flex overflow-x-auto ${header ? TOOLBAR_GROUP : "border-b border-edge-strong"} ${className}`}
      aria-label={ariaLabel}
    >
      {tabs.map((tab) => {
        const Icon = tab.icon;
        return (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            title={header && typeof tab.label === "string" ? tab.label : undefined}
            className={({ isActive }) => header
              ? toolbarItemClass(isActive)
              : `flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 font-display text-sm font-bold transition-colors ${
                isActive ? "border-accent text-accent-strong" : "border-transparent text-ink-muted hover:text-ink"
              }`}
          >
            {Icon && <Icon size={header ? 16 : 15} aria-hidden />}
            {header ? <span className="hidden xl:inline">{tab.label}</span> : tab.label}
          </NavLink>
        );
      })}
    </nav>
  );
}
