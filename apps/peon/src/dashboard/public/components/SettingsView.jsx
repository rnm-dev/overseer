(function () {
  const { Tabs, SettingsCard, AICard, ArmoryCard } = window.ACA;

  // Settings is a tabbed page rather than one long card: General (the daemon
  // controls + settings.json fields), AI (Claude Code auth + usage), and
  // Armory each get their own tab so the page doesn't get cluttered.
  const TABS = [
    { id: "general", label: "General" },
    { id: "ai", label: "AI" },
    { id: "armory", label: "Armory" },
  ];

  // `general` is the bare /settings path; everything else is /settings/<tab>.
  function tabPath(id) {
    return id === "general" ? "" : id;
  }

  function SettingsView({ status, subPath, navigate, onControlChange, refreshToken }) {
    // subPath: "" | "ai" | "ai/claude-code" | "armory" (relative to
    // /settings). First segment picks the tab; the rest is that tab's own
    // sub-navigation (only AI has any — its provider detail view).
    const [tab, ...rest] = subPath ? subPath.split("/") : [];
    const activeTab = tab || "general";
    const aiDetailId = rest[0];

    const tabs = TABS.map((t) => ({
      ...t,
      href: `/settings${tabPath(t.id) ? `/${tabPath(t.id)}` : ""}`,
      warn: t.id === "ai" && status?.claudeCodeAuthState === "broken",
    }));

    return (
      <div className="space-y-4">
        <Tabs tabs={tabs} active={activeTab} onSelect={(id) => navigate(tabPath(id))} />

        {activeTab === "general" && <SettingsCard status={status} onControlChange={onControlChange} />}

        {activeTab === "ai" && (
          <AICard
            selectedId={aiDetailId}
            onSelect={(id) => navigate(id ? `ai/${id}` : "ai")}
            refreshToken={refreshToken}
          />
        )}

        {activeTab === "armory" && <ArmoryCard subPath={rest.join("/")} navigate={(next) => navigate(next ? `armory/${next}` : "armory")} />}
      </div>
    );
  }

  window.ACA.SettingsView = SettingsView;
})();
