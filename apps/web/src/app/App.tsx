import { lazy, Suspense } from "react";
import { Navigate, Outlet, Route, Routes } from "react-router";
import { PeonSessionsEmpty } from "../features/sessions/PeonSessionsEmpty";
import { useAuth } from "../features/auth/auth";
import { useT } from "../shared/i18n";
import { loginRouteTarget } from "../features/auth/nativeLoginMode";
import { WorkspaceProvider } from "../features/workspaces/workspace";
import { LiveSocketProvider } from "../realtime/liveSocket";

const Login = lazy(() => import("../features/auth/Login").then((m) => ({ default: m.Login })));
const Dashboard = lazy(() => import("../features/workspaces/Dashboard").then((m) => ({ default: m.Dashboard })));
const OauthCallback = lazy(() => import("../features/auth/OauthCallback").then((m) => ({ default: m.OauthCallback })));
const Join = lazy(() => import("../features/auth/Join").then((m) => ({ default: m.Join })));
const JoinSession = lazy(() => import("../features/auth/JoinSession").then((m) => ({ default: m.JoinSession })));
const PeonDetail = lazy(() => import("../features/fleet/PeonDetail").then((m) => ({ default: m.PeonDetail })));
const PeonNewSession = lazy(() => import("../features/sessions/PeonNewSession").then((m) => ({ default: m.PeonNewSession })));
const PeonSessionDetail = lazy(() => import("../features/sessions/PeonSessionDetail").then((m) => ({ default: m.PeonSessionDetail })));
const PeonProjectDetail = lazy(() => import("../features/projects/PeonProjectDetail").then((m) => ({ default: m.PeonProjectDetail })));
const PeonStats = lazy(() => import("../features/stats/PeonStats").then((m) => ({ default: m.PeonStats })));
const PeonSettingsLayout = lazy(() => import("../features/settings/PeonSettingsLayout").then((m) => ({ default: m.PeonSettingsLayout })));
const Members = lazy(() => import("../features/workspaces/Members").then((m) => ({ default: m.Members })));
const WorkspaceDashboard = lazy(() => import("../features/workspaces/WorkspaceDashboard").then((m) => ({ default: m.WorkspaceDashboard })));
const WorkspaceSessions = lazy(() => import("../features/workspaces/WorkspaceSessions").then((m) => ({ default: m.WorkspaceSessions })));
const WorkspaceSessionsEmpty = lazy(() => import("../features/workspaces/WorkspaceSessions").then((m) => ({ default: m.WorkspaceSessionsEmpty })));
const ProjectMembers = lazy(() => import("../features/projects/ProjectMembers").then((m) => ({ default: m.ProjectMembers })));
const ProjectFileBrowser = lazy(() => import("../features/projects/ProjectFileBrowser").then((m) => ({ default: m.ProjectFileBrowser })));
const ProjectSkills = lazy(() => import("../features/projects/ProjectSkills").then((m) => ({ default: m.ProjectSkills })));
const ProjectArmoryPackages = lazy(() => import("../features/armory/ProjectArmoryPackages").then((m) => ({ default: m.ProjectArmoryPackages })));
const ProjectArmoryProfileNew = lazy(() => import("../features/armory/ProjectArmoryProfileNew").then((m) => ({ default: m.ProjectArmoryProfileNew })));
const ProjectSettings = lazy(() => import("../features/projects/ProjectSettings").then((m) => ({ default: m.ProjectSettings })));

function Loading() {
  const t = useT();
  return (
    <div className="grid min-h-screen place-items-center gap-4">
      <div className="flex flex-col items-center gap-4">
        <div className="loading-spinner" />
        <p className="rune text-xs text-ink-muted">{t("app.loading")}</p>
      </div>
    </div>
  );
}

function BackendUnavailable({ onRetry }: { onRetry: () => Promise<void> }) {
  const t = useT();
  return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div className="max-w-md">
        <h1 className="font-display text-2xl font-bold text-ink">{t("backend.unavailable.title")}</h1>
        <p className="mt-3 font-mono text-sm leading-6 text-ink-muted">{t("backend.unavailable.message")}</p>
        <button className="btn btn-accent mt-6" type="button" onClick={() => void onRetry()}>
          {t("backend.unavailable.retry")}
        </button>
      </div>
    </main>
  );
}

export function App() {
  const { user, ready, unavailable, retry } = useAuth();

  if (!ready) {
    return <Loading />;
  }

  if (unavailable) {
    return <BackendUnavailable onRetry={retry} />;
  }

  return (
    <Suspense fallback={<Loading />}><Routes>
      <Route
        path="/login"
        element={loginRouteTarget(Boolean(user), sessionStorage) === "dashboard" ? <Navigate to="/" replace /> : <Login />}
      />
      {/* Public: GitHub returns web and native OAuth here; invite links also work signed-out. */}
      <Route path="/auth/github/callback" element={<OauthCallback provider="github" />} />
      <Route path="/auth/oidc/callback" element={<OauthCallback provider="oidc" />} />
      <Route path="/join/session/:token" element={<JoinSession />} />
      <Route path="/join/:token" element={<Join />} />

      {/* Authed shell: workspace context + shared chrome, one <Outlet/> for every page. */}
      <Route
        element={
          user ? (
            <WorkspaceProvider>
              <LiveSocketProvider>
                {/* Thin authed shell: the fleet dashboard and the peon view each own their layout. */}
                <div className="flex min-h-screen flex-col">
                  <Outlet />
                </div>
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
          <Route path="sessions" element={<PeonSessionsEmpty />} />
          <Route path="sessions/new" element={<PeonNewSession />} />
          <Route path="sessions/:sid" element={<PeonSessionDetail />} />
          <Route path="projects/:key" element={<PeonProjectDetail />} />
          <Route path="projects/:key/files" element={<ProjectFileBrowser />} />
          <Route path="projects/:key/skills" element={<ProjectSkills />} />
          <Route path="projects/:key/tools" element={<ProjectArmoryPackages />} />
          <Route path="projects/:key/tools/new-profile" element={<ProjectArmoryProfileNew />} />
          <Route path="projects/:key/members" element={<ProjectMembers />} />
          <Route path="projects/:key/settings" element={<ProjectSettings />} />
          <Route path="stats" element={<PeonStats />} />
          <Route path="settings" element={<PeonSettingsLayout />}>
            {/* General and Agent render from the layout's persistent PeonSettings. */}
            <Route index element={null} />
            <Route path="agent" element={null} />
            <Route path="armory/:packageId?" element={null} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></Suspense>
  );
}
