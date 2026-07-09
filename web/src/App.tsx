import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { useT } from "./i18n";
import { WorkspaceProvider } from "./workspace";
import { LiveSocketProvider } from "./liveSocket";
import { AppLayout } from "./components/AppLayout";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { GithubCallback } from "./pages/GithubCallback";
import { Join } from "./pages/Join";
import { PeonDetail } from "./pages/PeonDetail";
import { PeonDashboard } from "./pages/peon/PeonDashboard";
import { PeonSessions } from "./pages/peon/PeonSessions";
import { PeonSessionDetail } from "./pages/peon/PeonSessionDetail";
import { PeonProjects } from "./pages/peon/PeonProjects";
import { PeonProjectDetail } from "./pages/peon/PeonProjectDetail";
import { PeonStats } from "./pages/peon/PeonStats";
import { PeonSettings } from "./pages/peon/PeonSettings";

export function App() {
  const { user, ready } = useAuth();
  const t = useT();

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center gap-4">
        <div className="flex flex-col items-center gap-4">
          <div className="forge-spin" />
          <p className="rune text-xs text-bone-dim">{t("app.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      {/* Public: GitHub redirects here, and invite links resolve here — both work signed-out. */}
      <Route path="/auth/github/callback" element={<GithubCallback />} />
      <Route path="/join/:token" element={<Join />} />

      {/* Authed shell: workspace context + shared chrome, one <Outlet/> for every page. */}
      <Route
        element={
          user ? (
            <WorkspaceProvider>
              <LiveSocketProvider>
                <AppLayout />
              </LiveSocketProvider>
            </WorkspaceProvider>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="peons/:peonId" element={<PeonDetail />}>
          <Route index element={<PeonDashboard />} />
          <Route path="sessions" element={<PeonSessions />} />
          <Route path="sessions/:sid" element={<PeonSessionDetail />} />
          <Route path="projects" element={<PeonProjects />} />
          <Route path="projects/:key" element={<PeonProjectDetail />} />
          <Route path="stats" element={<PeonStats />} />
          <Route path="settings" element={<PeonSettings />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
