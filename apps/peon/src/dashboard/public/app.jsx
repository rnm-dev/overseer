(function () {
  const { useState, useEffect, useRef } = React;
  const {
    Landing,
    Sidebar,
    ActiveUsersCard,
    PeonOverviewCard,
    ProjectsCard,
    RecentSessionsCard,
    SessionsCard,
    AIUsageWidget,
    SettingsView,
    OverseerCard,
    DashboardGate,
    ContentWrapper,
    useStatus,
    useSettings,
    usePathView,
    API_BASE,
  } = window.ACA;

  function App() {
    const { status, reachable, refresh } = useStatus();
    const settings = useSettings();
    const peonName = settings?.name?.trim() ? settings.name.trim() : "Peon";
    const [pollToken, setPollToken] = useState(0);
    const [path, navigate] = usePathView("home");
    const [topView, ...rest] = path.split("/");
    const subId = rest[0];
    const subPath = rest.join("/");

    // AI became a Settings tab — keep its old top-level URLs working.
    useEffect(() => {
      if (topView === "ai") {
        navigate(["settings", topView, ...rest].join("/"));
      }
    }, [topView, subPath, navigate]);

    // Baseline/idle tab title — SessionDetail takes over document.title
    // while a session it's showing is running, and hands it back to this
    // value the moment it isn't (status flips, or it unmounts).
    useEffect(() => {
      document.title = peonName;
    }, [peonName]);

    // Who currently has the dashboard open, on any page — one SSE
    // connection for the whole app's lifetime (App only mounts once past
    // DashboardGate, and never unmounts again until logout), not per-view.
    // Seeded from the existing 4s status poll's `activeUsers` snapshot
    // until the stream's own first "presence" frame arrives, at which point
    // activeUsersLiveRef stops the poll from re-overwriting live data with
    // an older snapshot — same guard used in SessionDetail for the same
    // reason (two independent, differently-timed sources of the same state).
    const [activeUsers, setActiveUsers] = useState([]);
    const activeUsersLiveRef = useRef(false);

    useEffect(() => {
      if (status?.activeUsers && !activeUsersLiveRef.current) setActiveUsers(status.activeUsers);
    }, [status]);

    useEffect(() => {
      const es = new EventSource(`${API_BASE}/api/v1/presence/stream`, { withCredentials: true });
      es.addEventListener("presence", (e) => {
        activeUsersLiveRef.current = true;
        setActiveUsers(JSON.parse(e.data).users);
      });
      return () => es.close();
    }, []);

    return (
      <div className="flex h-screen flex-col overflow-hidden md:flex-row">
        <Sidebar
          view={topView}
          onNavigate={navigate}
          name={settings?.name?.trim() || "unnamed"}
          status={status}
          reachable={reachable}
          onUpdated={refresh}
          activeUsers={activeUsers}
        />

        <ContentWrapper>
          {!reachable && (
            <p className="mb-6 rounded bg-red-950/60 px-4 py-3 text-sm text-red-300 ring-1 ring-inset ring-red-900">
              Cannot reach the control API at {API_BASE || window.location.origin}. Is the daemon running?
            </p>
          )}

          {topView === "home" && (
            <div className="space-y-4">
              <PeonOverviewCard settings={settings} onConfigure={() => navigate("settings")} />
              <ActiveUsersCard users={activeUsers} />
              <RecentSessionsCard
                base="/sessions"
                onSelectSession={(id) => navigate(`sessions/${id}`)}
              />
              <AIUsageWidget refreshToken={pollToken} />
            </div>
          )}

          {topView === "projects" && (
            <ProjectsCard
              refreshToken={pollToken}
              base="/projects"
              onSelectSession={(id) => navigate(`sessions/${id}`)}
              subPath={subPath}
              navigate={(next) => navigate(next ? `projects/${next}` : "projects")}
            />
          )}

          {topView === "sessions" && (
            <SessionsCard
              selectedId={subId}
              subPath={subPath}
              base="/sessions"
              peonName={peonName}
              onSelect={(id) => navigate(id ? `sessions/${id}` : "sessions")}
            />
          )}

          {topView === "overseer" && <OverseerCard status={status} />}

          {topView === "settings" && (
            <SettingsView
              status={status}
              subPath={subPath}
              navigate={(next) => navigate(next ? `settings/${next}` : "settings")}
              onControlChange={refresh}
              refreshToken={pollToken}
            />
          )}
        </ContentWrapper>
      </div>
    );
  }

  function Root() {
    const isLanding = window.location.pathname === "/" && !new URLSearchParams(window.location.search).has("token");
    if (isLanding) return <Landing />;
    return (
      <DashboardGate>
        <App />
      </DashboardGate>
    );
  }

  ReactDOM.createRoot(document.getElementById("root")).render(<Root />);
})();
