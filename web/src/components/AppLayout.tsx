import { Outlet, useLocation } from "react-router-dom";
import { UserBox } from "./UserBox";

// author: Viktor
// Thin authed shell: no chrome of its own — the fleet dashboard and the peon
// view each own their layout. Account controls belong only to the home page.
export function showsUserBox(pathname: string): boolean {
  return pathname === "/";
}

export function AppLayout() {
  const { pathname } = useLocation();

  return (
    <div className="min-h-screen">
      <Outlet />
      {showsUserBox(pathname) && <UserBox />}
    </div>
  );
}
