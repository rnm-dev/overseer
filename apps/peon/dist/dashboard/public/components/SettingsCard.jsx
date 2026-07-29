(function () {
  const { useState, useEffect, useCallback } = React;
  const { PageHeader, Panel, Button, apiGet, apiPatch, apiPost, coerceValue, API_BASE } = window.ACA;

  function SettingsCard({ status, onControlChange }) {
    const [settings, setSettings] = useState(null);
    const [draft, setDraft] = useState({});
    const [saving, setSaving] = useState(false);
    const [controlBusy, setControlBusy] = useState(false);
    const [providers, setProviders] = useState([]);

    const load = useCallback(async () => {
      const { body } = await apiGet("/api/v1/settings");
      setSettings(body);
      setDraft(body);
    }, []);

    useEffect(() => {
      load();
      apiGet("/api/v1/models").then(({ ok, body }) => {
        if (ok) setProviders(body.providers ?? []);
      });
      const events = new EventSource(`${API_BASE}/api/v1/events`, { withCredentials: true });
      events.addEventListener("settings", (e) => {
        const body = JSON.parse(e.data);
        setSettings(body);
        setDraft(body);
      });
      return () => events.close();
    }, [load]);

    const save = async () => {
      setSaving(true);
      try {
        const patch = {};
        for (const [k, v] of Object.entries(draft)) {
          if (JSON.stringify(v) === JSON.stringify(settings?.[k])) continue;
          patch[k] = typeof v === "string" ? coerceValue(v) : v;
        }
        await apiPatch("/api/v1/settings", patch);
      } finally {
        setSaving(false);
      }
    };

    const control = async (action) => {
      setControlBusy(true);
      try {
        await apiPost(`/api/v1/control/${action}`);
        onControlChange();
      } finally {
        setControlBusy(false);
      }
    };

    const paused = Boolean(status?.state === "paused");
    const selectedProvider = providers.find((provider) => provider.agent === draft.defaultAgent);
    const models = selectedProvider?.models ?? [];
    const selectedModel = models.find((model) => model.id === draft.ai?.defaultModel)
      ?? models.find((model) => model.default)
      ?? models[0];
    const reasoningEfforts = selectedModel?.reasoningEfforts ?? [];

    return (
      <div className="space-y-4">
        <PageHeader
          title="settings"
          right={
            <div className="flex gap-2">
              <Button variant={paused ? "primary" : "ghost"} disabled={controlBusy} onClick={() => control("resume")}>
                Resume
              </Button>
              <Button variant={paused ? "ghost" : "danger"} disabled={controlBusy} onClick={() => control("pause")}>
                Pause
              </Button>
            </div>
          }
        />
        <Panel>
          {!settings && <p className="text-sm text-slate-500">Loading…</p>}
          {settings && (
          <div className="space-y-3">
            {/* Nested (object-valued) settings — currently just `ai` — get their
                own controls below; the generic text-input renderer only handles
                flat scalars, so skip objects here to avoid "[object Object]". */}
            {Object.entries(draft)
              .filter(([key, value]) => ![
                "aiDefaultModel",
                "aiDefaultReasoningEffort",
                "soul",
                "defaultAgent",
                "peonId",
                "overseerTokenSet",
                "pairingArmed",
                "pairingSecretExpiresAt",
              ].includes(key) && (typeof value !== "object" || value === null))
              .map(([key, value]) => (
              <label key={key} className="block">
                <span className="mb-1 block text-xs font-medium text-slate-400">{key}</span>
                <input
                  value={String(value)}
                  onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                  className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                />
              </label>
            ))}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">defaultAgent</span>
              <select
                value={draft.defaultAgent ?? ""}
                onChange={(e) => {
                  const provider = providers.find((candidate) => candidate.agent === e.target.value);
                  const defaultModel = provider?.defaultModel ?? null;
                  const model = provider?.models?.find((candidate) => candidate.id === defaultModel)
                    ?? provider?.models?.find((candidate) => candidate.default)
                    ?? provider?.models?.[0];
                  const defaultReasoningEffort = model?.reasoningEfforts?.find((effort) => effort.default)?.id ?? null;
                  setDraft((d) => ({
                    ...d,
                    defaultAgent: e.target.value,
                    aiDefaultModel: defaultModel,
                    aiDefaultReasoningEffort: defaultReasoningEffort,
                    ai: { ...d.ai, defaultModel, defaultReasoningEffort },
                  }));
                }}
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              >
                {providers.map((provider) => (
                  <option key={provider.agent} value={provider.agent}>
                    {provider.label}{provider.legacy ? " — legacy fallback" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">ai.defaultModel</span>
              <select
                value={draft.ai?.defaultModel ?? ""}
                onChange={(e) => {
                  const model = models.find((candidate) => candidate.id === e.target.value);
                  const defaultReasoningEffort = model?.reasoningEfforts?.find((effort) => effort.default)?.id ?? null;
                  setDraft((d) => ({
                    ...d,
                    aiDefaultModel: e.target.value,
                    aiDefaultReasoningEffort: defaultReasoningEffort,
                    ai: { ...d.ai, defaultModel: e.target.value, defaultReasoningEffort },
                  }));
                }}
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} ({m.id}){m.default ? " (Default)" : ""}
                  </option>
                ))}
                {/* Keep an unknown persisted value visible/selected rather than silently blank. */}
                {draft.ai?.defaultModel && !models.some((m) => m.id === draft.ai.defaultModel) && (
                  <option value={draft.ai.defaultModel}>{draft.ai.defaultModel}</option>
                )}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">ai.defaultReasoningEffort</span>
              <select
                value={draft.ai?.defaultReasoningEffort ?? ""}
                onChange={(e) => {
                  const defaultReasoningEffort = e.target.value || null;
                  setDraft((d) => ({
                    ...d,
                    aiDefaultReasoningEffort: defaultReasoningEffort,
                    ai: { ...d.ai, defaultReasoningEffort },
                  }));
                }}
                disabled={reasoningEfforts.length === 0}
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500 disabled:opacity-50"
              >
                <option value="">Provider default</option>
                {reasoningEfforts.map((effort) => (
                  <option key={effort.id} value={effort.id}>
                    {effort.label}{effort.default ? " (Model default)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Soul</span>
              <textarea
                value={draft.soul ?? ""}
                onChange={(e) => setDraft((d) => ({ ...d, soul: e.target.value }))}
                rows={10}
                placeholder="Describe this Peon's personality, voice, judgment, and working style…"
                className="w-full resize-y rounded border border-slate-700 bg-slate-950 px-3 py-2 text-sm leading-6 text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
              <span className="mt-1 block text-xs leading-5 text-slate-500">
                Markdown injected into every new agent turn after Peon's fixed harness rules and before project context. Leave empty to use the provider's default personality.
              </span>
            </label>
            <div className="pt-1">
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : "Save settings"}
              </Button>
            </div>
          </div>
        )}
        </Panel>
      </div>
    );
  }

  window.ACA.SettingsCard = SettingsCard;
})();
