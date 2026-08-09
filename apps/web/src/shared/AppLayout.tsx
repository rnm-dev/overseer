import { Outlet } from "react-router";

// author: Viktor
// Thin authed shell: no chrome of its own — the fleet dashboard and the peon
// view each own their layout. The home dashboard owns its in-flow account card.

export function AppLayout() {
  return (
    <div className="flex min-h-screen flex-col">
      <Outlet />
    </div>
  );
}
