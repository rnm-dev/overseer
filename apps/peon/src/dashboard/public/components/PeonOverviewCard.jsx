(function () {
  const { Card, Badge, Button } = window.ACA;

  function PeonOverviewCard({ settings, onConfigure }) {
    const soul = settings?.soul?.trim() || settings?.ai?.soul?.trim() || "";
    const model = settings?.aiDefaultModel ?? settings?.ai?.defaultModel ?? "provider default";
    return (
      <Card
        title={settings?.name?.trim() || "Peon overview"}
        right={<Button href="/settings" variant="ghost" onClick={onConfigure}>Configure</Button>}
      >
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Badge tone={soul ? "green" : "slate"}>{soul ? "soul configured" : "default personality"}</Badge>
              <span className="text-xs text-slate-500">{settings?.defaultAgent || "loading agent"} · {model}</span>
            </div>
            {soul ? (
              <p className="line-clamp-4 whitespace-pre-wrap text-sm leading-6 text-slate-300">{soul}</p>
            ) : (
              <p className="text-sm leading-6 text-slate-500">
                This Peon currently relies on the provider's personality plus Peon's operational harness rules.
              </p>
            )}
          </div>
        </div>
      </Card>
    );
  }

  window.ACA.PeonOverviewCard = PeonOverviewCard;
})();
