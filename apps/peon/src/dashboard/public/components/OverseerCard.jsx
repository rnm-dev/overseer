(function () {
  const { useState, useEffect, useCallback, useRef } = React;
  const { PageHeader, Panel, Button, Badge, Dot, apiGet, apiPost, timeAgo, API_BASE } = window.ACA;

  // Boils the live registrar state into a single headline chip. Mirrors the
  // states peonRegistrar.ts can be in: off (no creds), auth rejected (401),
  // registered (heartbeating), or mid-connect. `dot` is a full literal class so
  // the Tailwind CDN's DOM scan picks it up (constructed class names wouldn't).
  function linkStatus(ov, enrollment) {
    if (["starting", "polling", "approved", "acknowledging"].includes(enrollment?.state)) {
      return { tone: "amber", label: "claim pending", dot: "bg-amber-500", pulse: true };
    }
    if (enrollment?.state === "parked") {
      return { tone: "red", label: "claim needs attention", dot: "bg-red-500", pulse: false };
    }
    if (!ov || !ov.enabled) return { tone: "slate", label: "standalone", dot: "bg-slate-500", pulse: false };
    if (ov.derecruited) return { tone: "amber", label: "auth rejected", dot: "bg-amber-500", pulse: true };
    if (ov.registered) return { tone: "green", label: "connected", dot: "bg-emerald-500", pulse: true };
    if (ov.lastError) return { tone: "amber", label: "connecting…", dot: "bg-amber-500", pulse: false };
    return { tone: "amber", label: "connecting…", dot: "bg-amber-500", pulse: true };
  }

  // Copy `value` to the clipboard, returning whether it worked. navigator.clipboard
  // only exists in a *secure* context (https or localhost) — the dashboard is
  // routinely served over plain http on the mesh (http://peon-serik.mesh.rnm:4571),
  // where it's undefined. So fall back to the legacy execCommand("copy") over a
  // hidden textarea, which works on plain http too.
  async function copyToClipboard(value) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
        return true;
      }
    } catch {
      // fall through to the execCommand path
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  // A value chip that's both manually selectable (the <code> is user-select:all,
  // so one click selects the whole token for a hand copy) and click-to-copy via a
  // separate button that flips to "copied" on success. The two are separate
  // elements on purpose: text inside a <button> can't be selected, and the earlier
  // all-in-one-button version also died silently on http (no secure clipboard).
  function Copyable({ value, className = "" }) {
    const [copied, setCopied] = useState(false);
    const timer = useRef(null);
    useEffect(() => () => clearTimeout(timer.current), []);
    const copy = async () => {
      const ok = await copyToClipboard(value);
      if (!ok) return;
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    };
    return (
      <span className={`inline-flex items-center gap-1.5 rounded bg-slate-950 px-2 py-1 ring-1 ring-inset ring-slate-700 ${className}`}>
        <code className="cursor-text select-all truncate text-xs">{value}</code>
        <button
          type="button"
          onClick={copy}
          title="Copy to clipboard"
          className={`flex-none text-[10px] font-medium transition ${
            copied ? "text-emerald-400" : "text-slate-500 hover:text-slate-200"
          }`}
        >
          {copied ? "copied" : "copy"}
        </button>
      </span>
    );
  }

  function StatusRow({ label, children }) {
    return (
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="text-slate-500">{label}</span>
        <span className="min-w-0 truncate text-right text-slate-200">{children}</span>
      </div>
    );
  }

  function OverseerCard({ status }) {
    const [peonId, setPeonId] = useState(null);
    const [arming, setArming] = useState(false);
    const [serverOrigin, setServerOrigin] = useState("");
    const [claim, setClaim] = useState(null);
    const [pairing, setPairing] = useState(null);
    const [pairingError, setPairingError] = useState("");

    const load = useCallback(async () => {
      const { body } = await apiGet("/api/v1/settings");
      setPeonId(body?.peonId ?? "");
      setServerOrigin(body?.overseerUrl ?? "");
    }, []);

    useEffect(() => {
      load();
      const events = new EventSource(`${API_BASE}/api/v1/events`, { withCredentials: true });
      events.addEventListener("settings", (e) => setPeonId(JSON.parse(e.data)?.peonId ?? ""));
      return () => events.close();
    }, [load]);

    const startClaim = async () => {
      setArming(true);
      setPairingError("");
      try {
        const { ok, body } = await apiPost("/api/v1/enrollment/claim", { serverOrigin });
        if (ok) {
          setClaim(body);
          if (body?.legacyPhrase) setPairing({ phrase: body.legacyPhrase, expiresAt: body.legacyExpiresAt });
        } else setPairingError(body?.error || "Could not start the outbound claim.");
      } catch (error) {
        setPairingError(error instanceof Error ? error.message : "Could not reach the daemon.");
      } finally {
        setArming(false);
      }
    };

    const armLegacy = async () => {
      setArming(true);
      setPairingError("");
      try {
        const { ok, body } = await apiPost("/api/v1/pairing/arm");
        if (ok) setPairing(body);
        else setPairingError(body?.error || "Could not arm legacy pairing.");
      } finally {
        setArming(false);
      }
    };

    const retryParked = async () => {
      setArming(true);
      setPairingError("");
      try {
        const { ok, body } = await apiPost("/api/v1/enrollment/retry");
        if (ok) setClaim(body);
        else setPairingError(body?.error || "Could not retry the parked enrollment.");
      } finally {
        setArming(false);
      }
    };

    const ov = status?.overseer;
    const enrollment = status?.enrollment;
    const liveClaim = enrollment?.state && enrollment.state !== "idle" ? enrollment : claim;
    const link = linkStatus(ov, liveClaim);
    const pairingLive = pairing && pairing.expiresAt > Date.now();

    return (
      <div className="space-y-4">
        <PageHeader
          title="overseer"
          subtitle="Connect this peon to a fleet control plane"
          right={
            <Badge tone={link.tone}>
              <Dot color={link.dot} pulse={link.pulse} />
              {link.label}
            </Badge>
          }
        />

        {/* Live connection state, straight off the registrar. */}
        <Panel className="space-y-2.5">
          <StatusRow label="Link">{ov?.enabled ? "configured" : "not configured"}</StatusRow>
          <StatusRow label="Registered">{ov?.registered ? "yes" : "no"}</StatusRow>
          <StatusRow label="Address">
            {ov?.publicUrl ? <Copyable value={ov.publicUrl} /> : <span className="text-slate-600">—</span>}
          </StatusRow>
          <StatusRow label="Peon ID">
            {peonId ? <Copyable value={peonId} /> : <span className="text-slate-600">—</span>}
          </StatusRow>
          <StatusRow label="Last registered">{timeAgo(ov?.lastRegisteredAt) ?? <span className="text-slate-600">never</span>}</StatusRow>
          <StatusRow label="Last heartbeat">{timeAgo(ov?.lastHeartbeatAt) ?? <span className="text-slate-600">never</span>}</StatusRow>
          {ov?.derecruited && (
            <p className="rounded bg-amber-950/50 px-3 py-2 text-xs text-amber-300 ring-1 ring-inset ring-amber-900">
              Overseer rejected this peon's credential (401). Peon is retrying with backoff; re-pair only if the rejection persists.
            </p>
          )}
          {ov?.lastError && !ov?.derecruited && (
            <p className="truncate text-xs text-amber-400" title={ov.lastError}>
              last error: {ov.lastError}
            </p>
          )}
        </Panel>

        <Panel className="space-y-3">
          <div>
            <h3 className="mb-1 text-sm font-semibold text-slate-300">Outbound enrollment</h3>
            <p className="text-sm text-slate-500">
              Enter the canonical Overseer origin. Peon creates a stable machine identity, starts a signed outbound
              claim, and keeps polling until an owner approves it. No inbound address is required.
            </p>
          </div>
          <input
            value={serverOrigin}
            onChange={(event) => setServerOrigin(event.target.value)}
            placeholder="https://overseer.example"
            className="w-full rounded bg-slate-950 px-3 py-2 text-sm text-slate-200 ring-1 ring-inset ring-slate-700"
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={startClaim} disabled={arming || !serverOrigin.trim()}>
              {arming ? "Starting…" : "Start outbound claim"}
            </Button>
            {liveClaim?.state === "parked" && (
              <Button onClick={retryParked} disabled={arming}>
                Retry after recovery
              </Button>
            )}
            {liveClaim?.operatorCode && <Copyable value={liveClaim.operatorCode} className="text-brand-300" />}
            {liveClaim?.operatorUrl && <Copyable value={liveClaim.operatorUrl} className="max-w-full text-brand-300" />}
          </div>
          {liveClaim?.state === "parked" && (
            <p className="rounded bg-amber-950/50 px-3 py-2 text-xs text-amber-300 ring-1 ring-inset ring-amber-900">
              Automatic retries stopped after a permanent protocol outcome
              {liveClaim.lastErrorCode ? ` (${liveClaim.lastErrorCode})` : ""}. Correct the condition, then retry explicitly.
            </p>
          )}
          <div className="border-t border-slate-800 pt-3">
            <button type="button" onClick={armLegacy} disabled={arming} className="text-xs text-slate-500 hover:text-slate-300">
              Arm legacy inbound pairing instead
            </button>
            {pairingLive && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <Copyable value={pairing.phrase} className="text-brand-300" />
                <span className="text-slate-500">expires {new Date(pairing.expiresAt).toLocaleTimeString()}</span>
              </div>
            )}
            {pairing && !pairingLive && <span className="text-xs text-slate-600">phrase expired — arm again</span>}
          </div>
          {pairingError && (
            <p className="rounded bg-red-950/50 px-3 py-2 text-xs text-red-300 ring-1 ring-inset ring-red-900">
              {pairingError}
            </p>
          )}
        </Panel>
      </div>
    );
  }

  window.ACA.OverseerCard = OverseerCard;
})();
