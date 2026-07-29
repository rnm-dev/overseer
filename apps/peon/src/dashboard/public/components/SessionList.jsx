(function () {
  const { useState, useEffect, useCallback, useRef } = React;
  const {
    Badge,
    Button,
    NavLink,
    PageHeader,
    List,
    Toggle,
    apiGet,
    apiPost,
    apiPatch,
    apiUpload,
    timeAgo,
    useInterval,
    useTitleSpinner,
    API_BASE,
    SessionTranscript,
    AttachmentPicker,
  } = window.ACA;

  // Shift+Tab toggles plan mode from the composer, mirroring interactive
  // Claude Code's own shortcut — plain Tab is left untouched so normal focus
  // order elsewhere on the page still works.
  function handlePlanModeKeyDown(e, setPlanMode) {
    if (e.key === "Tab" && e.shiftKey) {
      e.preventDefault();
      setPlanMode((v) => !v);
    }
  }

  // Model catalog for the composer pickers, fetched once and cached across
  // mounts (both composers share it). Shape:
  // { providers: [{ agent, label, models, reasoningEfforts? }] }. Each list
  // marks its selected default directly on one record.
  let modelCatalogCache = null;
  function useModelCatalog() {
    const [catalog, setCatalog] = useState(modelCatalogCache);
    useEffect(() => {
      if (modelCatalogCache) return;
      let cancelled = false;
      apiGet("/api/v1/models").then(({ ok, body }) => {
        if (cancelled || !ok) return;
        modelCatalogCache = body;
        setCatalog(body);
      });
      return () => {
        cancelled = true;
      };
    }, []);
    return catalog;
  }

  // Empty state still means "follow the session/global default" (nothing is
  // sent), while the actual default record is visibly preselected.
  function ModelSelect({ value, onChange, catalog, disabled, title, agent = "claude-code" }) {
    const models = (catalog?.providers ?? []).find((p) => p.agent === agent)?.models ?? [];
    const defaultModel = models.find((model) => model.default);
    return (
      <select
        value={value || defaultModel?.id || ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title={title ?? "Model — overrides the session default for this message"}
        className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
      >
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}{m.default ? " (Default)" : ""}
          </option>
        ))}
      </select>
    );
  }

  function ReasoningEffortSelect({ value, onChange, catalog, disabled, agent = "claude-code", model }) {
    const provider = (catalog?.providers ?? []).find((p) => p.agent === agent);
    const selectedModel = provider?.models?.find((candidate) => candidate.id === model)
      ?? provider?.models?.find((candidate) => candidate.default)
      ?? provider?.models?.[0];
    const efforts = selectedModel?.reasoningEfforts ?? [];
    if (efforts.length === 0) return null;
    const defaultEffort = efforts.find((effort) => effort.default);
    return (
      <select
        value={value || defaultEffort?.id || ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title="Thinking effort — overrides the selected model default"
        className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
      >
        {efforts.map((effort) => (
          <option key={effort.id} value={effort.id}>
            {effort.label}{effort.default ? " (Default)" : ""}
          </option>
        ))}
      </select>
    );
  }

  // Cmd+Enter on macOS, Ctrl+Enter on Linux/Windows submits the new-session
  // composer — the platform's native "send" chord. SEND_CHORD_LABEL is shown
  // on the Start button so the shortcut is discoverable.
  const IS_MAC = /Mac|iP(hone|ad|od)/.test(navigator.platform || "");
  const SEND_CHORD_LABEL = IS_MAC ? "⌘↵" : "Ctrl+↵";
  function isSendChord(e) {
    return e.key === "Enter" && (IS_MAC ? e.metaKey : e.ctrlKey);
  }

  // Collection records carry only a bounded promptPreview; detail records may
  // still carry taskTitle/prompt. Keep one fallback that handles both shapes.
  function sessionDisplayName(record) {
    return record.title || record.taskTitle || record.promptPreview || record.prompt || record.lastMessagePreview || "Untitled session";
  }

  // A composer draft (the message you've started typing but not sent yet) is
  // persisted per session so leaving the tab — or a full reload — doesn't lose
  // it. Keyed by session id under localStorage; cleared the moment the message
  // is dispatched (the composer empties, which persists an empty draft → removed).
  const draftStorageKey = (id) => `peon.session-draft.${id}`;
  function loadDraft(id) {
    try {
      const raw = localStorage.getItem(draftStorageKey(id));
      if (!raw) return { text: "", planMode: false };
      const d = JSON.parse(raw);
      return { text: typeof d.text === "string" ? d.text : "", planMode: !!d.planMode };
    } catch {
      return { text: "", planMode: false };
    }
  }
  function saveDraft(id, text, planMode) {
    try {
      if (text.trim() || planMode) {
        localStorage.setItem(draftStorageKey(id), JSON.stringify({ text, planMode }));
      } else {
        localStorage.removeItem(draftStorageKey(id));
      }
    } catch {
      // Private-mode / quota errors are non-fatal — the draft just isn't durable.
    }
  }

  function statusTone(record) {
    if (record.status === "running") return "amber";
    if (record.outcome?.result === "success") return "green";
    if (record.outcome?.result === "needs_human") return "amber";
    return "red";
  }

  function statusLabel(record) {
    if (record.status === "running") return "running";
    return record.outcome?.result ?? "unknown";
  }

  // A completed session with no outcome is a chat-mode run that was never
  // asked to grade itself (SessionRecord.expectsOutcome === false) — not a
  // failure, so it gets no badge at all rather than a misleading "unknown".
  function hasStatusBadge(record) {
    return record.status === "running" || record.outcome !== null;
  }

  // Collection summaries expose lastActivityAt as the canonical sort time.
  // The fallbacks cover historical records until the daemon backfills it.
  function lastActivityTime(s) {
    return s.lastActivityAt ?? s.endedAt ?? s.startedAt;
  }

  // Running sessions always rank above completed ones; within each group,
  // newest-activity first.
  function compareSessions(a, b) {
    const aRunning = a.status === "running";
    const bRunning = b.status === "running";
    if (aRunning !== bRunning) return aRunning ? -1 : 1;
    return lastActivityTime(b) - lastActivityTime(a);
  }

  // Per-agent usage widget registry, keyed by SessionRecord.agent — modular
  // so a future second agent can plug in its own widget (or none) without
  // touching this dispatch. Claude Code has no programmatic access to
  // account-wide usage limits (no CLI command/config/stream-json event
  // exposes the 5h/weekly subscription caps — confirmed against Anthropic's
  // own docs and an explicitly-declined feature request), so its widget
  // shows the one real signal available: this session's own cost/token
  // spend, off the CLI's result event.
  function ClaudeCodeUsageWidget({ record }) {
    const [expanded, setExpanded] = useState(false);
    const usage = record.usage;
    if (!usage) return null;
    const rows = [
      usage.totalCostUsd != null && ["Cost", `$${usage.totalCostUsd.toFixed(4)}`],
      usage.durationMs != null && ["Duration", `${(usage.durationMs / 1000).toFixed(1)}s`],
      usage.inputTokens != null && ["Input tokens", usage.inputTokens.toLocaleString()],
      usage.outputTokens != null && ["Output tokens", usage.outputTokens.toLocaleString()],
      usage.cacheReadInputTokens && ["Cache read", usage.cacheReadInputTokens.toLocaleString()],
      usage.cacheCreationInputTokens && ["Cache write", usage.cacheCreationInputTokens.toLocaleString()],
    ].filter(Boolean);
    if (rows.length === 0) return null;

    // Collapsed to the one thing worth a glance (cost + duration) rather than
    // the full breakdown taking up permanent space — the rest is one click away.
    const summary = [
      usage.totalCostUsd != null && `$${usage.totalCostUsd.toFixed(4)}`,
      usage.outputTokens != null && `${usage.outputTokens.toLocaleString()} out`,
      usage.durationMs != null && `${(usage.durationMs / 1000).toFixed(1)}s`,
    ]
      .filter(Boolean)
      .join(" · ");

    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="rounded border border-slate-800 bg-slate-900/40 px-2 py-1 text-[11px] text-slate-400 hover:border-slate-700 hover:text-slate-200"
        >
          {summary}
        </button>
        {expanded && (
          // Anchored left on mobile: the header row wraps there, so this
          // pill usually ends up near the left edge, and a right-anchored
          // popover would run off the left edge of the screen (confirmed on
          // a 375px viewport). sm+ headers don't wrap, so the pill sits at
          // the far right of the cluster and right-anchoring is what keeps
          // it inside the content column instead of overflowing right.
          <div className="absolute left-0 z-10 mt-1 w-64 max-w-[calc(100vw-2rem)] rounded-sm border border-slate-800 bg-slate-900 p-3 sm:left-auto sm:right-0">
            <p className="mb-1.5 text-[11px] font-medium text-slate-500">
              This session's usage
            </p>
            <div className="flex flex-col gap-1 text-xs text-slate-400">
              {rows.map(([label, value]) => (
                <span key={label}>
                  {label}: <span className="text-slate-200">{value}</span>
                </span>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-slate-600">
              Per-session spend — Claude Code doesn't expose account-wide usage limits programmatically.
            </p>
          </div>
        )}
      </div>
    );
  }

  const AGENT_USAGE_WIDGETS = {
    "claude-code": ClaudeCodeUsageWidget,
  };

  function AgentUsageWidget({ record }) {
    const Widget = record ? AGENT_USAGE_WIDGETS[record.agent] : null;
    if (!Widget) return null;
    return <Widget record={record} />;
  }

  // Who else currently has this session's detail page open — fed by the
  // stream's "presence" SSE events (see SessionDetail), not polling.
  function ViewersBadge({ viewers }) {
    if (!viewers || viewers.length === 0) return null;
    return (
      <Badge tone="slate" title={viewers.join(", ")}>
        {viewers.length} viewing
      </Badge>
    );
  }

  // How many rows the list reveals at a time — both the initial window and
  // the "Load more"/infinite-scroll increment.
  const SESSIONS_PAGE_SIZE = 20;

  function SessionsList({ onSelect, base }) {
    const [list, setList] = useState([]);
    const [projects, setProjects] = useState([]);
    const [projectFilter, setProjectFilter] = useState("all");
    // The list starts capped at the most recent SESSIONS_PAGE_SIZE rows with a
    // "Load more" button; clicking it flips `infinite` on, and from then the
    // sentinel below auto-extends the window as it scrolls into view.
    const [visibleCount, setVisibleCount] = useState(SESSIONS_PAGE_SIZE);
    const [infinite, setInfinite] = useState(false);
    const sentinelRef = useRef(null);

    const loadList = useCallback(async () => {
      const { body } = await apiGet("/api/v1/sessions");
      setList(body.sessions ?? []);
    }, []);

    useEffect(() => {
      loadList();
      apiGet("/api/v1/projects").then(({ body }) => setProjects(body?.projects ?? []));
    }, [loadList]);
    useInterval(loadList, 3000);

    // Switching the project filter changes which sessions there are, so start
    // its view over from the top window rather than carrying a stale count.
    useEffect(() => {
      setVisibleCount(SESSIONS_PAGE_SIZE);
      setInfinite(false);
    }, [projectFilter]);

    const projectLabel = useCallback(
      (key) => projects.find((p) => p.key === key)?.label ?? key,
      [projects],
    );

    const filteredList =
      projectFilter === "all"
        ? list
        : projectFilter === "none"
          ? list.filter((s) => !s.projectKey)
          : list.filter((s) => s.projectKey === projectFilter);

    // Chat-list ordering: running sessions always on top, most recently poked
    // (last user message) first; everything else below, most recently active
    // first (see compareSessions/lastActivityTime). Server records seed these
    // timestamps to startedAt, so old records still sort sensibly. Copy before
    // sorting — the server-provided array is reused across renders.
    const visibleList = [...filteredList].sort(compareSessions);
    const shownList = visibleList.slice(0, visibleCount);
    const hasMore = visibleCount < visibleList.length;

    // Once in infinite mode, an IntersectionObserver on the bottom sentinel
    // pulls in the next page as it nears the viewport. Re-created whenever the
    // count/length changes so it re-checks (and keeps loading if the sentinel
    // is still on-screen after a bump). rootMargin gives it a head start so
    // rows arrive before the user hits the very bottom.
    useEffect(() => {
      if (!infinite || !hasMore) return;
      const el = sentinelRef.current;
      if (!el) return;
      const obs = new IntersectionObserver(
        (entries) => {
          if (entries[0].isIntersecting) {
            setVisibleCount((c) => Math.min(c + SESSIONS_PAGE_SIZE, visibleList.length));
          }
        },
        { rootMargin: "300px" },
      );
      obs.observe(el);
      return () => obs.disconnect();
    }, [infinite, hasMore, visibleCount, visibleList.length]);

    const loadMore = () => {
      setInfinite(true);
      setVisibleCount((c) => Math.min(c + SESSIONS_PAGE_SIZE, visibleList.length));
    };

    const stopSession = async (sessionId) => {
      await apiPost(`/api/v1/sessions/${sessionId}/cancel`);
      await loadList();
    };

    return (
      <div className="space-y-4">
        <PageHeader
          title="sessions"
          subtitle="// deterministic coding-agent runs — every session ends success or failure"
          right={
            <>
              <select
                value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}
                className="flex-none rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-300 outline-none focus:border-brand-500"
              >
                <option value="all">All projects</option>
                <option value="none">No project</option>
                {projects.map((p) => (
                  <option key={p.key} value={p.key}>
                    {p.label}
                  </option>
                ))}
              </select>
              <Button
                href={
                  projectFilter !== "all" && projectFilter !== "none" ? `${base}/new/${projectFilter}` : `${base}/new`
                }
                onClick={() =>
                  onSelect(projectFilter !== "all" && projectFilter !== "none" ? `new/${projectFilter}` : "new")
                }
              >
                + New session
              </Button>
            </>
          }
        />

        <List>
          {visibleList.length === 0 && (
            <li className="px-4 py-3 text-sm text-slate-500">
              {list.length === 0 ? "No sessions yet." : "No sessions for this filter."}
            </li>
          )}
          {shownList.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-800/40">
              <NavLink href={`${base}/${s.id}`} onClick={() => onSelect(s.id)} className="min-w-0 flex-1 text-left">
                <p className="truncate text-sm font-medium text-slate-200">
                  {sessionDisplayName(s)}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {s.projectKey && <span className="text-slate-400">{projectLabel(s.projectKey)}</span>}
                  {s.projectKey && " · "}
                  {s.lastMessagePreview || s.outcome?.summary || "…"}
                </p>
              </NavLink>
              <div className="flex flex-none items-center gap-2">
                <span className="hidden text-xs text-slate-600 sm:inline">{timeAgo(lastActivityTime(s))}</span>
                {s.status === "running" && (
                  <Button variant="danger" onClick={() => stopSession(s.id)}>
                    Stop
                  </Button>
                )}
                {hasStatusBadge(s) && <Badge tone={statusTone(s)}>{statusLabel(s)}</Badge>}
              </div>
            </li>
          ))}
          {hasMore &&
            (infinite ? (
              // Sentinel row the observer watches; scrolling it into view loads
              // the next page. Kept a real <li> so List's divider styling holds.
              <li ref={sentinelRef} className="px-4 py-3 text-center text-xs text-slate-600">
                Loading more…
              </li>
            ) : (
              <li className="px-4 py-3 text-center">
                <button
                  type="button"
                  onClick={loadMore}
                  className="text-xs text-slate-400 hover:text-slate-200"
                >
                  Load more ({visibleList.length - visibleCount} older)
                </button>
              </li>
            ))}
        </List>
      </div>
    );
  }


  Object.assign(window.ACA, {
    handlePlanModeKeyDown,
    useModelCatalog,
    ModelSelect,
    ReasoningEffortSelect,
    SEND_CHORD_LABEL,
    isSendChord,
    sessionDisplayName,
    loadDraft,
    saveDraft,
    statusTone,
    statusLabel,
    hasStatusBadge,
    lastActivityTime,
    compareSessions,
    AgentUsageWidget,
    ViewersBadge,
    SessionsList,
  });
})();
