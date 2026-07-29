(function () {
  const { useState } = React;
  const { Dot, Button, apiPost } = window.ACA;

  // Compact sidebar widget — deliberately low-key (an update isn't urgent
  // the way an unreachable daemon is) rather than the full-width Card this
  // used to be in the main content area.
  function UpdateBanner({ status, onUpdated }) {
    const [expanded, setExpanded] = useState(false);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState(null);

    if (!status?.updateAvailable) return null;
    const current = status.updateCurrentVersion || status.updateCurrentRevision?.slice(0, 7);
    const latest = status.updateLatestVersion || status.updateLatestRevision?.slice(0, 7);

    const startUpdate = async (force) => {
      setLoading(true);
      setResult(null);
      try {
        const { ok, status: httpStatus, body } = await apiPost("/api/v1/control/update", { force });
        if (ok) {
          setResult({ ok: true, message: body.message ?? "update started", manualRestartRequired: body.manualRestartRequired === true });
          onUpdated?.();
        } else if (httpStatus === 409 && !force) {
          setResult({ ok: false, message: body.error, canForce: true });
        } else {
          setResult({ ok: false, message: body.error ?? "failed to start update" });
        }
      } catch (err) {
        setResult({ ok: false, message: err.message });
      } finally {
        setLoading(false);
      }
    };

    return (
      <div className="text-[11px]">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-center gap-2 text-amber-500 hover:text-amber-400"
        >
          <Dot color="bg-amber-500" />
          update available
        </button>

        {expanded && (
          <div className="mt-2 space-y-2 rounded border border-slate-800 bg-slate-900/60 p-2.5 normal-case tracking-normal">
            <p className="text-slate-500">
              {current && latest
                ? `${current} → ${latest}`
                : "a newer version is available"}
            </p>
            <p className="text-slate-600">
              Production installs restart services. Dev checkouts keep the daemon running and require a later manual restart.
            </p>
            <Button onClick={() => startUpdate(false)} disabled={loading}>
              {loading ? "Starting…" : "Update now"}
            </Button>
            {result && (
              <p className={result.ok ? "text-emerald-400" : "text-red-400"}>
                {result.ok ? "✓" : "✗"} {result.message}
              </p>
            )}
            {result?.canForce && (
              <Button variant="danger" onClick={() => startUpdate(true)} disabled={loading}>
                Force update anyway
              </Button>
            )}
            {result?.ok && (
              <p className="text-slate-500">
                {result.manualRestartRequired
                  ? "Dev mode keeps the daemon running. Restart npm run dev manually when it is safe to apply the changes."
                  : "The daemon is restarting — reload once it's back."}
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  window.ACA.UpdateBanner = UpdateBanner;
})();
