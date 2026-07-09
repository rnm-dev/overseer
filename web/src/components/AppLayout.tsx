import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth";
import { useWorkspace } from "../workspace";
import { Button, Logo, LocaleSwitcher, StatusDot } from "../ui";
import { useT } from "../i18n";
import { NewWorkspaceDialog } from "./NewWorkspaceDialog";

// author: Viktor

const itemBase = "flex items-center gap-2 rounded px-2.5 py-1.5 font-display text-[0.8rem] transition-colors";
const itemClass = (active: boolean) => `${itemBase} ${active ? "bg-fel/10 text-fel-bright" : "text-bone-dim hover:bg-iron-900 hover:text-bone"}`;

export function AppLayout() {
  const { user, logout } = useAuth();
  const t = useT();
  const { groups, current, setCurrent } = useWorkspace();
  const { pathname } = useLocation();
  const [showNewWs, setShowNewWs] = useState(false);

  const onDashboard = pathname === "/";

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 flex h-screen w-60 shrink-0 flex-col border-r border-iron-800 bg-iron-950/50">
        {/* brand */}
        <Link to="/" className="flex items-center gap-2.5 px-4 pb-3 pt-4">
          <Logo size={26} />
          <span className="wordmark text-base">Overseer</span>
        </Link>

        {/* workspace groups */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {groups.map(({ workspace: w, peons }) => (
            <div key={w.id} className="mb-3">
              <div className="truncate px-2.5 pb-1 pt-1 font-display text-[0.58rem] uppercase tracking-[0.16em] text-bone-faint">{w.name}</div>
              <Link to="/" onClick={() => setCurrent(w.id)} className={itemClass(onDashboard && current?.id === w.id)}>
                {t("nav.dashboard")}
              </Link>
              {peons.map((p) => (
                <NavLink key={p.peonId} to={`/peons/${p.peonId}`} onClick={() => setCurrent(w.id)} className={({ isActive }) => itemClass(isActive)}>
                  <StatusDot state={p.online ? "on" : "off"} />
                  <span className="truncate">{p.name || t("peons.unnamed")}</span>
                </NavLink>
              ))}
            </div>
          ))}
          <button className="btn-ghost w-full px-2.5 text-left" onClick={() => setShowNewWs(true)}>
            {t("nav.newWorkspace")}
          </button>
        </div>

        {/* footer */}
        <div className="space-y-2 border-t border-iron-800 px-3 py-3">
          <div className="truncate px-0.5 font-mono text-[0.7rem] text-bone-dim" title={user?.email}>
            {user?.email}
          </div>
          <div className="flex items-center justify-between gap-2">
            <LocaleSwitcher />
            <Button variant="iron" size="sm" onClick={() => logout()}>
              {t("action.signOut")}
            </Button>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1">
        <div className="mx-auto max-w-6xl px-6 py-7">
          <Outlet />
        </div>
      </main>

      {showNewWs && <NewWorkspaceDialog onClose={() => setShowNewWs(false)} />}
    </div>
  );
}
