import { Outlet, useLocation } from "react-router-dom";
import { UserBox } from "./UserBox";

// author: Viktor
// Thin authed shell: no chrome of its own — the fleet dashboard and the peon
// view each own their layout. The account panel is global on desktop, but on
// mobile it belongs only to the fleet dashboard.
export function AppLayout() {
  const { pathname } = useLocation();
  const isIndexPage = pathname === "/";

  return (
    <div className="min-h-screen">
      <Outlet />
      <UserBox hideOnMobile={!isIndexPage} />
    </div>
  );
}
