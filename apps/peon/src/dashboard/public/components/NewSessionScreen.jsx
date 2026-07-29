(function () {
  const { useState, useEffect } = React;
  const {
    Button, NavLink, PageHeader, Toggle, apiGet, apiPost, apiUpload, AttachmentPicker,
    handlePlanModeKeyDown, useModelCatalog, ModelSelect, ReasoningEffortSelect, SEND_CHORD_LABEL, isSendChord,
  } = window.ACA;

  function NewSessionScreen({ initialProjectKey, onBack, onStarted, base }) {
    const [projects, setProjects] = useState([]);
    const [projectKey, setProjectKey] = useState(initialProjectKey ?? "");
    const [prompt, setPrompt] = useState("");
    const [expectsOutcome, setExpectsOutcome] = useState(false);
    const [dir, setDir] = useState("");
    const [dirTouched, setDirTouched] = useState(false);
    const [planMode, setPlanMode] = useState(false);
    // The new session's default model ("" = follow the peon's global default).
    const [model, setModel] = useState("");
    const [reasoningEffort, setReasoningEffort] = useState("");
    const [agent, setAgent] = useState("");
    const catalog = useModelCatalog();
    const [stagedFiles, setStagedFiles] = useState([]);
    const [uploadProgress, setUploadProgress] = useState(null);
    const [starting, setStarting] = useState(false);
    const [startError, setStartError] = useState(null);

    useEffect(() => {
      apiGet("/api/v1/projects").then(({ body }) => {
        const list = body?.projects ?? [];
        setProjects(list);
        if (initialProjectKey) {
          const p = list.find((pr) => pr.key === initialProjectKey);
          if (p) setDir(p.dir);
        }
      });
    }, []);

    useEffect(() => {
      if (!agent && catalog?.defaultAgent) setAgent(catalog.defaultAgent);
    }, [agent, catalog]);

    const selectProject = (key) => {
      setProjectKey(key);
      if (!dirTouched) {
        const p = projects.find((pr) => pr.key === key);
        setDir(p ? p.dir : "");
      }
    };

    const start = async (e) => {
      e.preventDefault();
      if (!prompt.trim()) return;
      setStarting(true);
      setStartError(null);
      try {
        let ok, body;
        if (stagedFiles.length > 0) {
          const fd = new FormData();
          fd.append("prompt", prompt.trim());
          if (dir.trim()) fd.append("dir", dir.trim());
          if (projectKey) fd.append("projectKey", projectKey);
          if (planMode) fd.append("permissionMode", "plan");
          fd.append("agent", agent);
          if (model) fd.append("model", model);
          if (reasoningEffort) fd.append("reasoningEffort", reasoningEffort);
          if (expectsOutcome) fd.append("expectsOutcome", "true");
          stagedFiles.forEach((s) => fd.append("files", s.file, s.name));
          setUploadProgress(0);
          ({ ok, body } = await apiUpload("/api/v1/sessions", fd, setUploadProgress));
        } else {
          ({ ok, body } = await apiPost("/api/v1/sessions", {
            prompt: prompt.trim(),
            dir: dir.trim() || undefined,
            ...(projectKey ? { projectKey } : {}),
            ...(planMode ? { permissionMode: "plan" } : {}),
            agent,
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
            ...(expectsOutcome ? { expectsOutcome: true } : {}),
          }));
        }
        if (!ok) {
          setStartError(body.error ?? "failed to start session");
        } else {
          onStarted(body.id);
        }
      } finally {
        setStarting(false);
        setUploadProgress(null);
      }
    };

    return (
      <div className="space-y-4">
        <PageHeader
          title="new session"
          back={
            <NavLink href={base} onClick={onBack} className="mb-1 block text-xs text-slate-500 hover:text-slate-300">
              ← Sessions
            </NavLink>
          }
        />

        <form onSubmit={start} className="space-y-3 rounded-sm border border-slate-800 bg-slate-900/60 p-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Project (optional)</span>
            <select
              value={projectKey}
              onChange={(e) => selectProject(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            >
              <option value="">(no project)</option>
              {projects.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (isSendChord(e)) {
                e.preventDefault();
                start(e);
                return;
              }
              handlePlanModeKeyDown(e, setPlanMode);
            }}
            placeholder="Prompt for the agent…"
            rows={4}
            className="w-full resize-none rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
          />
          <AttachmentPicker
            items={stagedFiles}
            onChange={setStagedFiles}
            disabled={starting}
            uploadProgress={uploadProgress}
          />
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Directory</span>
            <input
              value={dir}
              onChange={(e) => {
                setDir(e.target.value);
                setDirTouched(true);
              }}
              placeholder="dir (optional — defaults to ~)"
              className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            />
          </label>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Toggle pressed={planMode} onToggle={() => setPlanMode((v) => !v)} title="Shift+Tab toggles plan mode" />
              <select
                value={agent}
                onChange={(e) => { setAgent(e.target.value); setModel(""); setReasoningEffort(""); }}
                disabled={starting}
                title="Coding agent for this session"
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              >
                {(catalog?.providers ?? []).map((provider) => (
                  <option key={provider.agent} value={provider.agent}>
                    {provider.label}{provider.legacy ? " — legacy" : ""}
                  </option>
                ))}
              </select>
              <ModelSelect
                value={model}
                onChange={(nextModel) => { setModel(nextModel); setReasoningEffort(""); }}
                catalog={catalog}
                agent={agent}
                disabled={starting}
                title="Default model for this session"
              />
              <ReasoningEffortSelect
                value={reasoningEffort}
                onChange={setReasoningEffort}
                catalog={catalog}
                agent={agent}
                model={model}
                disabled={starting}
              />
            </div>
            <Button type="submit" disabled={starting || !agent || !prompt.trim()}>
              {starting ? (
                "Starting…"
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  Start session
                  <kbd className="rounded border border-white/25 bg-white/10 px-1 py-px text-[11px] font-medium leading-none text-white/80">
                    {SEND_CHORD_LABEL}
                  </kbd>
                </span>
              )}
            </Button>
          </div>
          {startError && <p className="text-xs text-red-400">{startError}</p>}
        </form>
      </div>
    );
  }


  window.ACA.NewSessionScreen = NewSessionScreen;
})();
