import { lazy, Suspense, useEffect, useState } from "react";
import { Navigate, Route, Routes, useNavigate, useOutletContext, useParams } from "react-router-dom";
import { api } from "./api";
import { useAuth } from "./auth";
import { useT } from "./i18n";
import { WorkspaceProvider } from "./workspace";
import { LiveSocketProvider } from "./liveSocket";
import { AppLayout } from "./components/AppLayout";
import { peonSettingsPath } from "./pages/peon/settingsNavigation";
import type { PeonContext } from "./pages/peon/context";
import type { IndexedSessionLite } from "./pages/peon/sessionList";

const Login = lazy(() => import("./pages/Login").then((m) => ({ default: m.Login })));
const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const GithubCallback = lazy(() => import("./pages/GithubCallback").then((m) => ({ default: m.GithubCallback })));
const Join = lazy(() => import("./pages/Join").then((m) => ({ default: m.Join })));
const PeonDetail = lazy(() => import("./pages/PeonDetail").then((m) => ({ default: m.PeonDetail })));
const PeonNewSession = lazy(() => import("./pages/peon/PeonNewSession").then((m) => ({ default: m.PeonNewSession })));
const PeonSessionDetail = lazy(() => import("./pages/peon/PeonSessionDetail").then((m) => ({ default: m.PeonSessionDetail })));
const PeonProjectDetail = lazy(() => import("./pages/peon/PeonProjectDetail").then((m) => ({ default: m.PeonProjectDetail })));
const PeonStats = lazy(() => import("./pages/peon/PeonStats").then((m) => ({ default: m.PeonStats })));
const PeonSettings = lazy(() => import("./pages/peon/PeonSettings").then((m) => ({ default: m.PeonSettings })));
const Members = lazy(() => import("./pages/Members").then((m) => ({ default: m.Members })));
const WorkspaceDashboard = lazy(() => import("./pages/WorkspaceDashboard").then((m) => ({ default: m.WorkspaceDashboard })));
const WorkspaceSessions = lazy(() => import("./pages/WorkspaceSessions").then((m) => ({ default: m.WorkspaceSessions })));
const WorkspaceSessionsEmpty = lazy(() => import("./pages/WorkspaceSessions").then((m) => ({ default: m.WorkspaceSessionsEmpty })));
const ProjectMembers = lazy(() => import("./pages/peon/ProjectMembers").then((m) => ({ default: m.ProjectMembers })));
const ProjectFileBrowser = lazy(() => import("./pages/peon/ProjectFileBrowser").then((m) => ({ default: m.ProjectFileBrowser })));
const ProjectSkills = lazy(() => import("./pages/peon/ProjectSkills").then((m) => ({ default: m.ProjectSkills })));
const ProjectSettings = lazy(() => import("./pages/peon/ProjectSettings").then((m) => ({ default: m.ProjectSettings })));

function LegacyPeonArmoryRedirect() {
  const { peonId = "", packageId } = useParams();
  return <Navigate to={peonSettingsPath(peonId, "armory", packageId)} replace />;
}

function Loading() {
  const t = useT();
  return (
    <div className="grid min-h-screen place-items-center gap-4">
      <div className="flex flex-col items-center gap-4">
        <div className="forge-spin" />
        <p className="rune text-xs text-bone-dim">{t("app.loading")}</p>
      </div>
    </div>
  );
}

function PeonSessionsEmpty() {
  const t = useT();
  const navigate = useNavigate();
  const { peon, wsId } = useOutletContext<PeonContext>();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      peonId: peon.peonId,
      mine: "true",
      limit: "1",
      offset: "0",
    });
    api<{ sessions: IndexedSessionLite[] }>(`/workspaces/${encodeURIComponent(wsId)}/sessions?${query}`)
      .then((result) => {
        if (!active) return;
        const sessionId = result.sessions?.[0]?.sessionId;
        if (sessionId) navigate(encodeURIComponent(sessionId), { replace: true });
        else setLoading(false);
      })
      .catch(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [navigate, peon.peonId, wsId]);

  if (loading) return <div className="grid min-h-[55vh] place-items-center"><div className="forge-spin" /></div>;
  return (
    <div className="grid min-h-[55vh] place-items-center text-center">
      <div>
        <h1 className="font-display text-xl font-bold text-bone">{t("peon.tab.sessions")}</h1>
        <p className="mt-2 font-mono text-sm text-bone-faint">{t("sessions.choose")}</p>
      </div>
    </div>
  );
}

export function App() {
  const { user, ready } = useAuth();

  if (!ready) {
    return <Loading />;
  }

  return (
    <Suspense fallback={<Loading />}><Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      {/* Public: GitHub returns web and native OAuth here; invite links also work signed-out. */}
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
        <Route path="workspaces/:workspaceId" element={<WorkspaceDashboard />} />
        <Route path="workspaces/:workspaceId/members" element={<Members />} />
        <Route path="workspaces/:workspaceId/sessions" element={<WorkspaceSessions />}>
          <Route index element={<WorkspaceSessionsEmpty />} />
          <Route path=":peonId/:sid" element={<PeonSessionDetail />} />
        </Route>
        <Route path="peons/:peonId" element={<PeonDetail />}>
          <Route index element={<Navigate to="sessions" replace />} />
          <Route path="overview" element={<Navigate to="../sessions" relative="path" replace />} />
          <Route path="sessions" element={<PeonSessionsEmpty />} />
          <Route path="sessions/new" element={<PeonNewSession />} />
          <Route path="sessions/:sid" element={<PeonSessionDetail />} />
          <Route path="projects" element={<Navigate to="../sessions" relative="path" replace />} />
          <Route path="projects/:key" element={<PeonProjectDetail />} />
          <Route path="projects/:key/files" element={<ProjectFileBrowser />} />
          <Route path="projects/:key/skills" element={<ProjectSkills />} />
          <Route path="projects/:key/members" element={<ProjectMembers />} />
          <Route path="projects/:key/settings" element={<ProjectSettings />} />
          <Route path="stats" element={<PeonStats />} />
          <Route path="armory" element={<LegacyPeonArmoryRedirect />} />
          <Route path="armory/:packageId" element={<LegacyPeonArmoryRedirect />} />
          <Route path="settings" element={<PeonSettings />} />
          <Route path="settings/agent" element={<PeonSettings />} />
          <Route path="settings/armory" element={<PeonSettings />} />
          <Route path="settings/armory/:packageId" element={<PeonSettings />} />
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></Suspense>
  );
}
