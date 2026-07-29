(function () {
  const { useState, useEffect, useCallback, useRef } = React;
  const TRANSCRIPT_PAGE_SIZE = 200;
  const {
    Badge, Button, NavLink, Toggle, apiGet, apiPost, apiPatch, apiUpload,
    useTitleSpinner, API_BASE, SessionTranscript, AttachmentPicker,
    handlePlanModeKeyDown, useModelCatalog, ModelSelect, ReasoningEffortSelect, sessionDisplayName,
    loadDraft, saveDraft, statusTone, statusLabel, hasStatusBadge,
    AgentUsageWidget, ViewersBadge, SessionFilePreview, previewPathsFromEvent,
  } = window.ACA;

  function SessionDetail({ id, onBack, base, peonName }) {
    const [record, setRecord] = useState(null);
    const [events, setEvents] = useState([]);
    const [transcriptCursor, setTranscriptCursor] = useState(null);
    const [hasEarlierEvents, setHasEarlierEvents] = useState(false);
    const [loadingEarlier, setLoadingEarlier] = useState(false);
    const [streamBoundary, setStreamBoundary] = useState(null);
    const [viewers, setViewers] = useState([]);
    const [renaming, setRenaming] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [savingTitle, setSavingTitle] = useState(false);
    const [editingQueueItemId, setEditingQueueItemId] = useState(null);
    const [queueItemDraft, setQueueItemDraft] = useState("");
    const [savingQueueItem, setSavingQueueItem] = useState(false);
    const [followUp, setFollowUp] = useState("");
    const [planMode, setPlanMode] = useState(false);
    // Per-message model override. "" = follow the session/global default. Sticky:
    // seeded from the session's default on load, never reset on send, so a
    // redirected conversation keeps running on the chosen model.
    const [model, setModel] = useState("");
    const [reasoningEffort, setReasoningEffort] = useState("");
    const catalog = useModelCatalog();
    const [stagedFollowUpFiles, setStagedFollowUpFiles] = useState([]);
    const [followUpUploadProgress, setFollowUpUploadProgress] = useState(null);
    const [sendingFollowUp, setSendingFollowUp] = useState(false);
    const [followUpError, setFollowUpError] = useState(null);
    const [previewPath, setPreviewPath] = useState(null);
    const [previewOpen, setPreviewOpen] = useState(false);
    const [followFileChanges, setFollowFileChanges] = useState(true);
    const scrollRef = useRef(null);
    const followUpRef = useRef(null);
    const followFileChangesRef = useRef(true);
    // Guards the draft-persistence effect from firing on the render where the
    // loader below repopulates the composer for a newly-selected session —
    // otherwise that render would write the previous session's text under the
    // new session's key. Set by the loader, consumed once by the persister.
    const skipDraftPersistRef = useRef(false);
    // Record and presence updates can still race their initial GETs. Keep the
    // live flags separate so a slower response cannot overwrite fresher SSE
    // state. Transcript setup uses a durable snapshot-to-stream handoff below.
    const recordLiveRef = useRef(false);
    const loadedEventIdsRef = useRef(new Set());
    const pendingScrollRestoreRef = useRef(null);
    const loadingEarlierRef = useRef(false);
    const transcriptGenerationRef = useRef(0);
    const followUpRequestRef = useRef(0);
    const activeSessionIdRef = useRef(id);
    const viewersLiveRef = useRef(false);
    activeSessionIdRef.current = id;

    // Restore this session's persisted composer draft on mount / id change, and
    // keep it in sync as the human types. Runs before the record even loads, so
    // a queued message is visible again the instant the tab reopens.
    useEffect(() => {
      skipDraftPersistRef.current = true;
      const draft = loadDraft(id);
      setFollowUp(draft.text);
      setPlanMode(draft.planMode);
    }, [id]);

    useEffect(() => {
      if (skipDraftPersistRef.current) {
        skipDraftPersistRef.current = false;
        return;
      }
      saveDraft(id, followUp, planMode);
    }, [id, followUp, planMode]);

    useEffect(() => {
      let cancelled = false;
      transcriptGenerationRef.current += 1;
      followUpRequestRef.current += 1;
      recordLiveRef.current = false;
      loadedEventIdsRef.current = new Set();
      loadingEarlierRef.current = false;
      pendingScrollRestoreRef.current = null;
      viewersLiveRef.current = false;
      setRecord(null);
      setEvents([]);
      setTranscriptCursor(null);
      setHasEarlierEvents(false);
      setLoadingEarlier(false);
      setStreamBoundary(null);
      setSendingFollowUp(false);
      setFollowUpUploadProgress(null);
      setFollowUpError(null);
      setRenaming(false);
      setTitleDraft("");
      setSavingTitle(false);
      setEditingQueueItemId(null);
      setQueueItemDraft("");
      setSavingQueueItem(false);
      setViewers([]);
      setModel("");
      setReasoningEffort("");
      setPreviewPath(null);
      setPreviewOpen(false);
      setFollowFileChanges(true);
      followFileChangesRef.current = true;
      apiGet(`/api/v1/sessions/${id}`).then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) {
          setFollowUpError(body?.error ?? "failed to load session");
          return;
        }
        if (!recordLiveRef.current) setRecord(body);
        // Seed the composer's model picker from the session default, once per id.
        // Not driven by SSE, so it won't fight a mid-session pick.
        setModel(body.model ?? "");
        setReasoningEffort(body.reasoningEffort ?? "");
        // Seeds the count before the SSE "presence" frame below arrives, so
        // there's no flash of "0 viewing" on first load.
        if (!viewersLiveRef.current) setViewers(body.viewers ?? []);
      }).catch(() => {
        if (!cancelled) setFollowUpError("failed to load session");
      });
      apiGet(`/api/v1/sessions/${id}/transcript?limit=${TRANSCRIPT_PAGE_SIZE}`).then(({ ok, body }) => {
        if (cancelled) return;
        if (!ok) {
          setFollowUpError(body?.error ?? "failed to load transcript");
          return;
        }
        const snapshot = body.events ?? [];
        const ids = new Set(snapshot.map((event) => event.eventId).filter(Boolean));
        loadedEventIdsRef.current = ids;
        setEvents(snapshot);
        setTranscriptCursor(body.nextCursor ?? null);
        setHasEarlierEvents(body.hasMore === true);
        // The stream subscribes only after the bounded snapshot is known. Its
        // durable resume id closes the gap between this GET and EventSource
        // setup without replaying the entire older transcript.
        setStreamBoundary({ sessionId: id, eventId: snapshot.at(-1)?.eventId ?? "" });
      }).catch(() => {
        if (!cancelled) setFollowUpError("failed to load transcript");
      });
      return () => {
        cancelled = true;
      };
    }, [id]);

    useEffect(() => {
      followFileChangesRef.current = followFileChanges;
    }, [followFileChanges]);

    const openPreviewFile = useCallback((filePath) => {
      setPreviewPath(filePath);
      setPreviewOpen(true);
      setFollowFileChanges(false);
    }, []);

    const resumeFollowingFiles = useCallback(() => {
      setPreviewOpen(true);
      setFollowFileChanges(true);
    }, []);

    const status = record?.status ?? null;
    useTitleSpinner(status === "running", `Work work - ${peonName}`, peonName);

    // Open regardless of status — not just "running" — since presence and the
    // live transcript remain meaningful after completion. The snapshot's last
    // immutable event id seeds the replay boundary; status changes do not
    // force-close/reopen the connection.
    useEffect(() => {
      if (!streamBoundary || streamBoundary.sessionId !== id) return undefined;
      const resume = encodeURIComponent(streamBoundary.eventId);
      const es = new EventSource(`${API_BASE}/api/v1/sessions/${id}/stream?afterEventId=${resume}`, { withCredentials: true });
      es.addEventListener("event", (e) => {
        const event = JSON.parse(e.data);
        const eventId = e.lastEventId || event.eventId;
        if (eventId && !event.eventId) event.eventId = eventId;
        if (!eventId || !loadedEventIdsRef.current.has(eventId)) {
          if (eventId) loadedEventIdsRef.current.add(eventId);
          setEvents((prev) => [...prev, event]);
        }
        const previewPaths = previewPathsFromEvent(event);
        if (followFileChangesRef.current && previewPaths.length > 0) {
          setPreviewPath(previewPaths[previewPaths.length - 1]);
          setPreviewOpen(true);
        }
      });
      es.addEventListener("change", (e) => {
        recordLiveRef.current = true;
        setRecord(JSON.parse(e.data));
      });
      es.addEventListener("presence", (e) => {
        viewersLiveRef.current = true;
        setViewers(JSON.parse(e.data).viewers);
      });
      return () => es.close();
    }, [id, streamBoundary]);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) return;
      const restore = pendingScrollRestoreRef.current;
      if (restore) {
        el.scrollTop = restore.top + (el.scrollHeight - restore.height);
        pendingScrollRestoreRef.current = null;
      } else {
        el.scrollTop = el.scrollHeight;
      }
    }, [events.length]);

    const loadEarlier = useCallback(async () => {
      if (loadingEarlierRef.current || !hasEarlierEvents || !transcriptCursor) return;
      loadingEarlierRef.current = true;
      setLoadingEarlier(true);
      const generation = transcriptGenerationRef.current;
      const el = scrollRef.current;
      if (el) pendingScrollRestoreRef.current = { height: el.scrollHeight, top: el.scrollTop };
      try {
        const { ok, body } = await apiGet(
          `/api/v1/sessions/${id}/transcript?limit=${TRANSCRIPT_PAGE_SIZE}&cursor=${encodeURIComponent(transcriptCursor)}`,
        );
        if (generation !== transcriptGenerationRef.current || activeSessionIdRef.current !== id) return;
        if (!ok) {
          pendingScrollRestoreRef.current = null;
          setFollowUpError(body?.error ?? "failed to load earlier events");
        } else {
          const earlier = (body.events ?? []).filter((event) => {
            if (!event.eventId || loadedEventIdsRef.current.has(event.eventId)) return false;
            loadedEventIdsRef.current.add(event.eventId);
            return true;
          });
          setEvents((current) => [...earlier, ...current]);
          setTranscriptCursor(body.nextCursor ?? null);
          setHasEarlierEvents(body.hasMore === true);
        }
      } catch {
        if (generation === transcriptGenerationRef.current && activeSessionIdRef.current === id) {
          pendingScrollRestoreRef.current = null;
          setFollowUpError("failed to load earlier events");
        }
      } finally {
        if (generation === transcriptGenerationRef.current && activeSessionIdRef.current === id) {
          loadingEarlierRef.current = false;
          setLoadingEarlier(false);
        }
      }
    }, [hasEarlierEvents, id, transcriptCursor]);

    const cancel = () => apiPost(`/api/v1/sessions/${id}/cancel`);

    const startRename = () => {
      setTitleDraft(record?.title ?? "");
      setRenaming(true);
    };

    const saveTitle = async () => {
      const sessionId = id;
      setSavingTitle(true);
      try {
        const { ok, body } = await apiPatch(`/api/v1/sessions/${sessionId}`, { title: titleDraft });
        // The SSE "change" broadcast will also deliver this, but setting it
        // here avoids a flicker before that frame arrives.
        if (ok && activeSessionIdRef.current === sessionId) setRecord(body);
      } catch {
        if (activeSessionIdRef.current === sessionId) setFollowUpError("failed to rename session");
      } finally {
        if (activeSessionIdRef.current === sessionId) {
          setSavingTitle(false);
          setRenaming(false);
        }
      }
    };

    // Enter saves, Escape cancels — the same shortcuts the follow-up composer
    // and the rest of the app lean on for inline edits.
    const onTitleKeyDown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        saveTitle();
      } else if (e.key === "Escape") {
        e.preventDefault();
        setRenaming(false);
      }
    };

    const startQueueItemEdit = (item) => {
      setEditingQueueItemId(item.id);
      setQueueItemDraft(item.prompt);
      setFollowUpError(null);
    };

    const cancelQueueItemEdit = () => {
      setEditingQueueItemId(null);
      setQueueItemDraft("");
    };

    const saveQueueItem = async () => {
      const prompt = queueItemDraft.trim();
      if (!prompt || !editingQueueItemId) return;
      const sessionId = id;
      const itemId = editingQueueItemId;
      setSavingQueueItem(true);
      setFollowUpError(null);
      try {
        const { ok, body } = await apiPatch(`/api/v1/sessions/${sessionId}/queue/${itemId}`, { prompt });
        if (activeSessionIdRef.current !== sessionId) return;
        if (!ok) {
          setFollowUpError(body.error ?? "failed to edit queued message");
          return;
        }
        setRecord(body);
        cancelQueueItemEdit();
      } catch {
        if (activeSessionIdRef.current === sessionId) setFollowUpError("failed to edit queued message");
      } finally {
        if (activeSessionIdRef.current === sessionId) setSavingQueueItem(false);
      }
    };

    const onQueueItemKeyDown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        saveQueueItem();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelQueueItemEdit();
      }
    };

    // Once this session isn't running, check whether the most recent turn
    // was sent in plan mode — that's what drives the post-plan decision bar
    // below (there's no channel to answer ExitPlanMode's own approval prompt
    // mid-run, so peon surfaces the same "proceed vs. request changes"
    // choice one step later, once the plan is already visible in the
    // transcript).
    const lastTurnWasPlan =
      status !== "running" &&
      [...events].reverse().find((e) => e.type === "user_message")?.permissionMode === "plan";

    const dispatchFollowUp = useCallback(
      async (text, permissionMode, files = [], model, reasoningEffort, queue = false, startNow = false) => {
        const request = ++followUpRequestRef.current;
        setSendingFollowUp(true);
        setFollowUpError(null);
        try {
          let ok, body;
          if (files.length > 0) {
            const fd = new FormData();
            fd.append("prompt", text);
            if (permissionMode) fd.append("permissionMode", permissionMode);
            if (model) fd.append("model", model);
            if (reasoningEffort) fd.append("reasoningEffort", reasoningEffort);
            if (startNow) fd.append("startNow", "true");
            files.forEach((s) => fd.append("files", s.file, s.name));
            setFollowUpUploadProgress(0);
            ({ ok, body } = await apiUpload(`/api/v1/sessions/${id}/${queue ? "queue" : "followup"}`, fd, setFollowUpUploadProgress));
          } else {
            ({ ok, body } = await apiPost(`/api/v1/sessions/${id}/${queue ? "queue" : "followup"}`, {
              prompt: text,
              ...(permissionMode ? { permissionMode } : {}),
              ...(model ? { model } : {}),
              ...(reasoningEffort ? { reasoningEffort } : {}),
              ...(startNow ? { startNow: true } : {}),
            }));
          }
          if (!ok) {
            if (activeSessionIdRef.current === id) setFollowUpError(body.error ?? "failed to send follow-up");
          } else {
            // The durable SSE handoff owns transcript delivery, including the
            // synchronously appended user message. Avoid a second snapshot
            // whose response could reorder events around concurrent live data.
            if (activeSessionIdRef.current === id) setRecord(body);
          }
        } catch {
          if (activeSessionIdRef.current === id) setFollowUpError("failed to send follow-up");
        } finally {
          if (request === followUpRequestRef.current && activeSessionIdRef.current === id) {
            setSendingFollowUp(false);
            setFollowUpUploadProgress(null);
          }
        }
      },
      [id],
    );

    // Running sessions queue by default. The explicit startNow action first
    // enqueues (preserving FIFO order), then stops the current task so the
    // queue head can begin. Completed sessions resume immediately as before.
    const submitFollowUp = (e, startNow = false) => {
      e.preventDefault();
      const text = followUp.trim();
      if (!text) return;
      const permissionMode = planMode ? "plan" : undefined;
      const files = stagedFollowUpFiles;
      setFollowUp("");
      setPlanMode(false);
      setStagedFollowUpFiles([]);
      // model is intentionally NOT reset — the picker is sticky across sends.
      dispatchFollowUp(
        text, permissionMode, files, model || undefined, reasoningEffort || undefined,
        status === "running", startNow,
      );
    };

    const approvePlan = () => dispatchFollowUp("Proceed with the plan as described.", undefined);
    const requestPlanChanges = () => {
      setPlanMode(true);
      followUpRef.current?.focus();
    };

    return (
      // Mobile has more surrounding chrome (top bar + fixed bottom nav) than
      // desktop's sidebar-only layout, so the two breakpoints get different
      // fixed heights — approximate, not pixel-exact, but close enough that
      // the transcript's own scroll region doesn't fight the page's.
      <div className="flex h-[calc(100vh-15rem)] flex-col md:h-[calc(100vh-9rem)]">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <NavLink href={base} onClick={onBack} className="mb-1 text-xs text-slate-500 hover:text-slate-300">
              ← Sessions
            </NavLink>
            {renaming ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={onTitleKeyDown}
                  placeholder="Session name (blank to clear)…"
                  disabled={savingTitle}
                  className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                />
                <Button onClick={saveTitle} disabled={savingTitle}>
                  {savingTitle ? "Saving…" : "Save"}
                </Button>
                <Button variant="ghost" onClick={() => setRenaming(false)} disabled={savingTitle}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="group flex items-center gap-2">
                <p className="truncate text-sm font-medium text-slate-200">
                  {record?.taskKey && <span className="text-sky-400">{record.taskKey}</span>}
                  {record?.taskKey && " — "}
                  {record ? sessionDisplayName(record) : "…"}
                </p>
                {record && (
                  <button
                    type="button"
                    onClick={startRename}
                    title="Rename session"
                    className="flex-none text-xs text-slate-500 opacity-0 transition-opacity hover:text-slate-300 focus:opacity-100 group-hover:opacity-100"
                  >
                    ✏️ Rename
                  </button>
                )}
              </div>
            )}
            {/* Once a title is set, the original prompt still shows here so its
                context isn't lost behind the rename. */}
            {record?.title && <p className="truncate text-xs text-slate-500">{record.prompt}</p>}
            {record && <p className="text-xs text-slate-500">{record.dir}</p>}
          </div>
          <div className="flex flex-none items-center gap-2">
            <ViewersBadge viewers={viewers} />
            {record && <Badge tone="slate" title="Coding agent">{record.agent}</Badge>}
            {record && catalog && (() => {
              const models = (catalog.providers ?? []).find((p) => p.agent === record.agent)?.models ?? [];
              const id = record.model || models.find((model) => model.default)?.id;
              if (!id) return null;
              const label = models.find((m) => m.id === id)?.label ?? id;
              // Show the session's chosen model, or the global default marked
              // "(default)" when the session just follows it.
              return (
                <Badge tone="slate" title="Session default model">
                  {record.model ? label : `${label} (default)`}
                </Badge>
              );
            })()}
            <AgentUsageWidget record={record} />
            {previewPath && !previewOpen && (
              <Button variant="ghost" onClick={() => setPreviewOpen(true)}>
                Preview
              </Button>
            )}
            {record && hasStatusBadge(record) && (
              <Badge tone={statusTone(record)}>
                {status === "running" && (
                  <span className="relative mr-0.5 inline-flex h-1.5 w-1.5">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500 opacity-60" />
                    <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
                  </span>
                )}
                {statusLabel(record)}
              </Badge>
            )}
            {status === "running" && (
              <Button variant="danger" onClick={cancel}>
                Stop
              </Button>
            )}
          </div>
        </div>

        <div className={`grid min-h-0 flex-1 gap-3 ${previewOpen ? "md:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]" : "grid-cols-1"}`}>
          <div
            ref={scrollRef}
            className={`${previewOpen ? "hidden md:block" : "block"} overflow-y-auto rounded-sm border border-slate-800 bg-slate-900/40 p-4`}
          >
            {hasEarlierEvents && (
              <div className="mb-3 flex items-center justify-center gap-2 text-xs text-slate-500">
                <Button variant="ghost" onClick={loadEarlier} disabled={loadingEarlier}>
                  {loadingEarlier ? "Loading…" : "Load earlier"}
                </Button>
                <span>{events.length} events loaded</span>
              </div>
            )}
            <SessionTranscript
              events={events}
              live={status === "running"}
              finalOutcome={record?.outcome}
              prompt={record?.prompt}
              peonName={peonName}
              onOpenFile={openPreviewFile}
              sessionDir={record?.dir}
            />
          </div>
          {previewOpen && previewPath && (
            <SessionFilePreview
              sessionId={id}
              filePath={previewPath}
              sessionDir={record?.dir}
              following={followFileChanges}
              onFollow={resumeFollowingFiles}
              onClose={() => {
                setPreviewOpen(false);
                setFollowFileChanges(false);
              }}
            />
          )}
        </div>

        {record && (
          <div className="mt-3 flex-none space-y-1.5">
            {(record.queuedFollowUps ?? []).length > 0 && (
              <div className="rounded border border-sky-900 bg-sky-950/30 px-3 py-2">
                <p className="mb-1 text-xs font-medium text-sky-300">
                  Queue · {record.queuedFollowUps.length} waiting
                </p>
                <ol className="space-y-1 text-xs text-slate-400">
                  {record.queuedFollowUps.map((item, index) => (
                    <li key={item.id} className="flex min-w-0 items-center gap-2">
                      <span className="text-slate-600">{index + 1}.</span>
                      {editingQueueItemId === item.id ? (
                        <>
                          <textarea
                            autoFocus
                            rows="2"
                            value={queueItemDraft}
                            onChange={(e) => setQueueItemDraft(e.target.value)}
                            onKeyDown={onQueueItemKeyDown}
                            disabled={savingQueueItem}
                            className="min-w-0 flex-1 resize-y rounded border border-sky-700 bg-slate-950 px-2 py-1 text-xs text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                          />
                          <Button onClick={saveQueueItem} disabled={savingQueueItem || !queueItemDraft.trim()}>
                            {savingQueueItem ? "Saving…" : "Save"}
                          </Button>
                          <Button variant="ghost" onClick={cancelQueueItemEdit} disabled={savingQueueItem}>
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <span className="min-w-0 flex-1 truncate" title={item.prompt}>{item.prompt}</span>
                          {item.attachments?.length > 0 && <span>{item.attachments.length} file(s)</span>}
                          {item.model && <span>{item.model}</span>}
                          {item.reasoningEffort && <span>{item.reasoningEffort}</span>}
                          {item.author && <span>{item.author}</span>}
                          <Button variant="ghost" onClick={() => startQueueItemEdit(item)}>
                            Edit
                          </Button>
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
            {lastTurnWasPlan && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-400">
                <span>A plan was proposed — ready to code, or want changes?</span>
                <div className="flex flex-none gap-2">
                  <Button onClick={approvePlan} disabled={sendingFollowUp}>
                    ✅ Looks good — proceed
                  </Button>
                  <Button variant="ghost" onClick={requestPlanChanges} disabled={sendingFollowUp}>
                    ✏️ Request changes
                  </Button>
                </div>
              </div>
            )}
            <form onSubmit={submitFollowUp} className="space-y-1.5">
              <AttachmentPicker
                items={stagedFollowUpFiles}
                onChange={setStagedFollowUpFiles}
                disabled={sendingFollowUp}
                uploadProgress={followUpUploadProgress}
              />
              <div className="flex gap-2">
                <input
                  ref={followUpRef}
                  value={followUp}
                  onChange={(e) => setFollowUp(e.target.value)}
                  onKeyDown={(e) => handlePlanModeKeyDown(e, setPlanMode)}
                  placeholder={
                    status === "running"
                      ? "Queue a follow-up for after the current task…"
                      : "Send a message — the agent keeps its context, and this may change the outcome…"
                  }
                  className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-600 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
                />
                <ModelSelect
                  value={model}
                  onChange={(nextModel) => { setModel(nextModel); setReasoningEffort(""); }}
                  catalog={catalog}
                  agent={record?.agent}
                  disabled={sendingFollowUp}
                />
                <ReasoningEffortSelect
                  value={reasoningEffort}
                  onChange={setReasoningEffort}
                  catalog={catalog}
                  agent={record?.agent}
                  model={model}
                  disabled={sendingFollowUp}
                />
                <Toggle pressed={planMode} onToggle={() => setPlanMode((v) => !v)} title="Shift+Tab toggles plan mode" />
                <Button type="submit" disabled={sendingFollowUp || !followUp.trim()}>
                  {sendingFollowUp ? "Sending…" : status === "running" ? "Queue" : "Send"}
                </Button>
                {status === "running" && (
                  <Button type="button" variant="danger" disabled={sendingFollowUp || !followUp.trim()} onClick={(e) => submitFollowUp(e, true)}>
                    Queue &amp; stop
                  </Button>
                )}
              </div>
              {followUpError && <p className="text-xs text-red-400">{followUpError}</p>}
            </form>
          </div>
        )}
      </div>
    );
  }


  window.ACA.SessionDetail = SessionDetail;
})();
