(function () {
  const { useState, useEffect, useCallback } = React;
  const { Card, apiGet, apiPost, onUnauthorized, useInterval } = window.ACA;

  function DashboardGate({ children }) {
    const [phase, setPhase] = useState("checking"); // checking | gate | ready

    const checkStatus = useCallback(async () => {
      const { body } = await apiGet("/api/v1/auth/status");
      setPhase(body?.authenticated ? "ready" : "gate");
    }, []);

    useEffect(() => {
      // The magic link (`peon user auth-link`) points here with `?token=` rather than at
      // the control API directly — this page reads the token and POSTs it itself, a plain
      // cross-origin call like every other dashboard->API request.
      const url = new URL(window.location.href);
      const token = url.searchParams.get("token");
      if (!token) {
        checkStatus();
        return;
      }
      // Strip it before the request, not after — it's one-time-use, so it must be gone
      // from the URL even if the POST below fails (otherwise a refresh retries a token
      // that's already burned).
      url.searchParams.delete("token");
      window.history.replaceState({}, "", url.pathname + url.search + url.hash);
      (async () => {
        try {
          await apiPost("/api/v1/auth/consume", { token });
        } finally {
          checkStatus();
        }
      })();
    }, [checkStatus]);

    useEffect(() => onUnauthorized(() => setPhase("gate")), []);

    // There's no in-page login form anymore — logging in only happens by
    // opening a magic link (possibly in another tab), so poll for it rather
    // than requiring a manual reload. Same fixed cadence as useStatus's own
    // polling; harmless to keep running once "ready" too.
    useInterval(checkStatus, 4000);

    if (phase === "checking") return null;
    if (phase === "ready") return children;

    return (
      <div className="flex h-screen items-center justify-center bg-slate-950 px-4">
        <div className="w-full max-w-sm">
          <Card title="Peon">
            <p className="text-sm text-slate-400">
              Not logged in. Ask an operator to run{" "}
              <code className="rounded bg-slate-800 px-1 py-0.5 text-xs text-brand-400">
                peon user auth-link &lt;your-username&gt;
              </code>{" "}
              and open the link they send you — this page updates automatically once you do.
            </p>
          </Card>
        </div>
      </div>
    );
  }

  window.ACA.DashboardGate = DashboardGate;
})();
