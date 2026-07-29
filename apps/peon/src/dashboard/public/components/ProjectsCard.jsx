(function () {
  const { useState, useEffect, useCallback } = React;
  const { Card, PageHeader, List, Panel, Badge, Button, NavLink, apiGet, apiPost, apiPatch, apiDelete, timeAgo } =
    window.ACA;
  const { API_BASE, formatBytes } = window.ACA;

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

  // #projects — read-only list. Create/edit live on their own pages.
  function ProjectsList({ refreshToken, navigate, base }) {
    const [data, setData] = useState(null);

    const load = useCallback(async () => {
      const { body } = await apiGet("/api/v1/projects");
      setData(body);
    }, []);

    useEffect(() => {
      load();
    }, [load, refreshToken]);

    const projects = data?.projects ?? null;

    return (
      <div className="space-y-4">
        <PageHeader
          title="projects"
          right={
            <Button href={`${base}/new`} onClick={() => navigate("new")}>
              + New project
            </Button>
          }
        />
        {projects && projects.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-4 px-4 py-12 text-center">
            <div className="rounded-full bg-slate-800/60 p-4 text-slate-400 ring-1 ring-inset ring-slate-700/60">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-8 w-8">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 10.5v6m3-3H9m4.06-7.19-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
                />
              </svg>
            </div>
            <div>
              <p className="text-sm font-medium text-slate-200">No projects yet</p>
              <p className="mt-1 text-xs text-slate-500">
                Create a project to give peon something to work on.
              </p>
            </div>
            <Button href={`${base}/new`} onClick={() => navigate("new")}>
              + New project
            </Button>
          </div>
        )}
        {projects && projects.length > 0 && (
          <List>
            {projects.map((p) => (
              <li key={p.key}>
                <NavLink
                  href={`${base}/${p.key}`}
                  onClick={() => navigate(p.key)}
                  className="flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-800/40"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-200">{p.label}</p>
                    <p className="truncate text-xs text-slate-500">{p.dir}</p>
                  </div>
                </NavLink>
              </li>
            ))}
          </List>
        )}
      </div>
    );
  }

  // #projects/new — create a local project.
  function ProjectsNewPage({ navigate, onSelectSession, base }) {
    const [label, setLabel] = useState("");
    const [dir, setDir] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);

    const create = async (e) => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      try {
        const { ok, body } = await apiPost("/api/v1/projects", { label, dir });
        if (!ok) setError(body.error ?? "failed to create");
        else if (body.onboardingSessionId) onSelectSession(body.onboardingSessionId);
        else navigate(body.key);
      } finally {
        setSaving(false);
      }
    };

    return (
      <div className="space-y-4">
        <PageHeader
          title="new project"
          back={
            <NavLink
              href={base}
              onClick={() => navigate("")}
              className="mb-1 block text-xs text-slate-500 hover:text-slate-300"
            >
              ← Projects
            </NavLink>
          }
        />
        <Panel>
          <form onSubmit={create} className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Name</span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              autoFocus
              className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Directory</span>
            <input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              placeholder={label.trim() ? `~/Projects/${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : ""}
              className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            />
          </label>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={saving || !label.trim()}>
              {saving ? "Creating…" : "Create"}
            </Button>
            <Button href={base} variant="ghost" disabled={saving} onClick={() => navigate("")}>
              Cancel
            </Button>
          </div>
        </form>
        </Panel>
      </div>
    );
  }

  // #projects/:key/settings (`edit` remains a compatibility alias below).
  function ProjectsSettingsPage({ projectKey, navigate, base }) {
    const [project, setProject] = useState(null);
    const [key, setKey] = useState("");
    const [name, setName] = useState("");
    const [dir, setDir] = useState("");
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
      apiGet(`/api/v1/projects/${projectKey}/settings`).then((settingsResponse) => {
        if (!settingsResponse.ok) {
          setError(settingsResponse.body?.error ?? "failed to load project settings");
          return;
        }
        const editable = settingsResponse.body;
        setProject(editable);
        setKey(editable?.key ?? projectKey);
        setName(editable?.name ?? "");
        setDir(editable?.dir ?? "");
      });
    }, [projectKey]);

    const save = async (e) => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      try {
        const settingsUpdate = await apiPatch(`/api/v1/projects/${projectKey}/settings`, { key, name, dir });
        if (!settingsUpdate.ok) {
          setError(settingsUpdate.body?.error ?? "failed to update project settings");
          return;
        }
        navigate(settingsUpdate.body.key);
      } finally {
        setSaving(false);
      }
    };

    const remove = async () => {
      setDeleting(true);
      setError(null);
      try {
        const { ok, body } = await apiDelete(`/api/v1/projects/${projectKey}`);
        if (!ok) setError(body.error ?? "failed to delete");
        else navigate("");
      } finally {
        setDeleting(false);
      }
    };

    if (!project) return <Panel>{error ?? "Loading…"}</Panel>;

    return (
      <div className="space-y-4">
        <PageHeader
          title={`${project.name} settings`}
          back={
            <NavLink
              href={`${base}/${projectKey}`}
              onClick={() => navigate(projectKey)}
              className="mb-1 block text-xs text-slate-500 hover:text-slate-300"
            >
              ← {project.name}
            </NavLink>
          }
        />
        <Panel>
          <form onSubmit={save} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-400">Key</span>
              <input
                value={key}
                onChange={(e) => setKey(e.target.value)}
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                title="Lowercase letters and numbers separated by single hyphens"
                className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
              />
              <span className="mt-1 block text-[11px] text-slate-500">Used in project URLs and API references.</span>
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-400">Project folder</span>
            <input
              value={dir}
              onChange={(e) => setDir(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-xs text-slate-100 outline-none focus:border-brand-500 focus:ring-1 focus:ring-brand-500"
            />
            <span className="mt-1 block text-[11px] text-slate-500">
              Where sessions run. Re-points the project; the old directory is left untouched.
            </span>
          </label>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button type="submit" disabled={saving || !key.trim() || !name.trim() || !dir.trim()}>
                {saving ? "Saving…" : "Save"}
              </Button>
              <Button href={`${base}/${projectKey}`} variant="ghost" disabled={saving} onClick={() => navigate(projectKey)}>
                Cancel
              </Button>
            </div>
            <Button variant="danger" disabled={deleting} onClick={remove}>
              {deleting ? "Deleting…" : "Delete project"}
            </Button>
          </div>
        </form>
        </Panel>
      </div>
    );
  }

  // Live file browser rooted at an absolute host path. Project pages pass the
  // project's dir, but the API itself is not coupled to project records. Subscribes to the daemon's SSE
  // stream, which pushes an initial snapshot on connect and re-sends on every
  // filesystem change, so the list stays current while this card is open. `cwd`
  // is a path relative to the project root; changing it re-opens the stream for
  // that subdirectory.
  function ProjectFiles({ root }) {
    const [cwd, setCwd] = useState("");
    const [entries, setEntries] = useState(null);
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(null); // relative path of the open file, or null
    const [fileData, setFileData] = useState(null);
    const [fileError, setFileError] = useState(null);

    useEffect(() => {
      setEntries(null);
      setError(null);
      const params = new URLSearchParams({ root });
      if (cwd) params.set("path", cwd);
      const es = new EventSource(`${API_BASE}/api/v1/fs/stream?${params}`, { withCredentials: true });
      es.addEventListener("files", (e) => {
        setError(null);
        setEntries(JSON.parse(e.data).entries);
      });
      es.addEventListener("failed", (e) => {
        setError(JSON.parse(e.data).error);
      });
      return () => es.close();
    }, [root, cwd]);

    // Fetch the open file's contents. One-shot (not streamed) — re-runs only
    // when the selection changes.
    useEffect(() => {
      if (!selected) return;
      let cancelled = false;
      setFileData(null);
      setFileError(null);
      const params = new URLSearchParams({ root, path: selected });
      apiGet(`/api/v1/fs/file?${params}`).then(({ ok, body }) => {
        if (cancelled) return;
        if (ok) setFileData(body);
        else setFileError(body.error ?? "failed to open file");
      });
      return () => {
        cancelled = true;
      };
    }, [root, selected]);

    const parts = cwd ? cwd.split("/") : [];
    const open = (name) => setCwd(cwd ? `${cwd}/${name}` : name);
    const goTo = (i) => setCwd(parts.slice(0, i + 1).join("/"));
    const openFile = (name) => setSelected(cwd ? `${cwd}/${name}` : name);

    if (selected) {
      return (
        <Card title="Files">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate font-mono text-sm text-slate-200">{selected}</span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="shrink-0 text-xs text-slate-400 hover:text-slate-200"
            >
              ← Back to files
            </button>
          </div>
          {fileError && <p className="text-sm text-red-400">{fileError}</p>}
          {!fileError && !fileData && <p className="text-sm text-slate-500">Loading…</p>}
          {fileData && fileData.binary && (
            <p className="text-sm text-slate-500">
              Binary file ({formatBytes(fileData.size)}) — can't preview.
            </p>
          )}
          {fileData && !fileData.binary && (
            <>
              {fileData.truncated && (
                <p className="mb-2 text-xs text-amber-400">
                  Showing the first 2 MB of {formatBytes(fileData.size)} — file truncated.
                </p>
              )}
              <pre className="max-h-[32rem] overflow-auto rounded bg-slate-950 p-3 text-xs leading-relaxed text-slate-300">
                {fileData.content}
              </pre>
            </>
          )}
        </Card>
      );
    }

    return (
      <Card title="Files">
        <div className="mb-3 flex flex-wrap items-center gap-1 text-xs text-slate-400">
          <button type="button" onClick={() => setCwd("")} className="hover:text-slate-200">
            {/* project root */}
            root
          </button>
          {parts.map((p, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-slate-600">/</span>
              <button type="button" onClick={() => goTo(i)} className="hover:text-slate-200">
                {p}
              </button>
            </span>
          ))}
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        {!error && entries === null && <p className="text-sm text-slate-500">Loading…</p>}
        {!error && entries && entries.length === 0 && <p className="text-sm text-slate-500">Empty directory.</p>}
        {!error && entries && entries.length > 0 && (
          <ul className="divide-y divide-slate-800">
            {entries.map((f) =>
              f.type === "dir" ? (
                <li key={f.name}>
                  <button
                    type="button"
                    onClick={() => open(f.name)}
                    className="flex w-full items-center gap-3 py-2 text-left hover:bg-slate-800/30"
                  >
                    <span aria-hidden className="text-slate-500">📁</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-200">{f.name}</span>
                    <span className="text-xs text-slate-600">{timeAgo(f.mtimeMs) ?? ""}</span>
                  </button>
                </li>
              ) : (
                <li key={f.name}>
                  <button
                    type="button"
                    onClick={() => openFile(f.name)}
                    disabled={f.type !== "file"}
                    className="flex w-full items-center gap-3 py-2 text-left enabled:hover:bg-slate-800/30 disabled:cursor-default"
                  >
                    <span aria-hidden className="text-slate-600">📄</span>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-300">{f.name}</span>
                    <span className="text-xs tabular-nums text-slate-600">
                      {f.size != null ? formatBytes(f.size) : ""}
                    </span>
                    <span className="w-16 text-right text-xs text-slate-600">{timeAgo(f.mtimeMs) ?? ""}</span>
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </Card>
    );
  }

  function DocumentationTree({ nodes, selected, onSelect }) {
    return (
      <ul className="space-y-1">
        {nodes.map((node) => (
          <li key={node.path}>
            {node.type === "directory" ? (
              <details open className="pl-1">
                <summary className="cursor-pointer py-1 text-xs text-slate-400">{node.name}</summary>
                <div className="ml-2 border-l border-slate-800 pl-2">
                  <DocumentationTree nodes={node.children} selected={selected} onSelect={onSelect} />
                </div>
              </details>
            ) : (
              <button
                type="button"
                onClick={() => onSelect(node.path)}
                className={`w-full truncate rounded px-2 py-1 text-left text-xs ${selected === node.path ? "bg-brand-500/15 text-brand-300" : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-200"}`}
              >
                {node.name}
              </button>
            )}
          </li>
        ))}
      </ul>
    );
  }

  function ProjectDocumentation({ projectKey, documentation }) {
    const [selected, setSelected] = useState(documentation?.index?.path ?? null);
    const [page, setPage] = useState(documentation?.index ?? null);
    const [error, setError] = useState(null);

    useEffect(() => {
      setSelected(documentation?.index?.path ?? null);
      setPage(documentation?.index ?? null);
      setError(null);
    }, [projectKey, documentation?.index?.mtimeMs]);

    const select = async (docPath) => {
      setSelected(docPath);
      setError(null);
      const { ok, body } = await apiGet(`/api/v1/projects/${projectKey}/docs/${docPath.split("/").map(encodeURIComponent).join("/")}`);
      if (ok) setPage(body);
      else setError(body?.error ?? "failed to load document");
    };

    if (!documentation?.exists) {
      return <Card title="Documentation"><p className="text-sm text-slate-500">No docs directory.</p></Card>;
    }

    return (
      <Card title="Documentation" right={<span className="font-mono text-[11px] text-slate-600">docs/{selected ?? ""}</span>}>
        <div className="grid gap-4 md:grid-cols-[14rem_minmax(0,1fr)]">
          <nav className="max-h-[32rem] overflow-auto border-b border-slate-800 pb-3 md:border-b-0 md:border-r md:pb-0 md:pr-3">
            <DocumentationTree nodes={documentation.tree ?? []} selected={selected} onSelect={select} />
          </nav>
          <div className="min-w-0">
            {error && <p className="text-sm text-red-400">{error}</p>}
            {!error && !page && <p className="text-sm text-amber-400">docs/index.md is missing.</p>}
            {!error && page && page.path.endsWith(".txt") && <pre className="overflow-auto whitespace-pre-wrap text-xs text-slate-300">{page.content}</pre>}
            {!error && page && !page.path.endsWith(".txt") && (
              <div
                className="prose prose-invert max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: window.DOMPurify.sanitize(window.marked.parse(page.content, { breaks: true })) }}
              />
            )}
            {page?.truncated && <p className="mt-3 text-xs text-amber-400">Document preview is truncated.</p>}
          </div>
        </div>
      </Card>
    );
  }

  // #projects/:key — docs, dir, and this project's sessions.
  function ProjectsShowPage({ projectKey, navigate, onSelectSession, base }) {
    const [project, setProject] = useState(null);
    const [sessionList, setSessionList] = useState(null);

    const load = useCallback(async () => {
      const [{ body: p }, { body: s }] = await Promise.all([
        apiGet(`/api/v1/projects/${projectKey}`),
        apiGet(`/api/v1/sessions?projectKey=${encodeURIComponent(projectKey)}`),
      ]);
      setProject(p);
      setSessionList(s?.sessions ?? []);
    }, [projectKey]);

    useEffect(() => {
      load();
    }, [load]);

    if (!project) return <Panel>Loading…</Panel>;
    if (project.error === "unknown project") return <Panel>Not found.</Panel>;

    return (
      <div className="space-y-4">
        <PageHeader
          title={project.label}
          back={
            <NavLink
              href={base}
              onClick={() => navigate("")}
              className="mb-1 block text-xs text-slate-500 hover:text-slate-300"
            >
              ← Projects
            </NavLink>
          }
          right={
            <Button href={`${base}/${projectKey}/settings`} variant="ghost" onClick={() => navigate(`${projectKey}/settings`)}>
              Settings
            </Button>
          }
        />
        <Panel>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-xs font-medium text-slate-500">Key</dt>
              <dd className="font-mono text-xs text-slate-300">{project.key}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-500">Directory</dt>
              <dd className="flex flex-wrap items-center gap-2 text-slate-300">
                {project.dir}
              </dd>
            </div>
          </dl>
        </Panel>

        <ProjectDocumentation projectKey={projectKey} documentation={project.documentation} />

        <Card
          title="Sessions"
          right={
            <Button href={`/sessions/new/${projectKey}`} onClick={() => onSelectSession(`new/${projectKey}`)}>
              + New session
            </Button>
          }
        >
          {sessionList && sessionList.length === 0 && <p className="text-sm text-slate-500">No sessions yet.</p>}
          {sessionList && sessionList.length > 0 && (
            <ul className="divide-y divide-slate-800">
              {sessionList.map((s) => (
                <li key={s.id}>
                  <NavLink
                    href={`/sessions/${s.id}`}
                    onClick={() => onSelectSession(s.id)}
                    className="flex w-full items-center gap-3 py-2.5 text-left hover:bg-slate-800/30"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-200">
                        {s.title || s.promptPreview || s.lastMessagePreview || "Untitled session"}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {timeAgo(s.startedAt)} · {s.outcome?.summary ?? "…"}
                      </p>
                    </div>
                    <Badge tone={statusTone(s)}>{statusLabel(s)}</Badge>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <ProjectFiles root={project.dir} />
      </div>
    );
  }

  function ProjectsCard({ refreshToken, onSelectSession, subPath, navigate, base }) {
    const parts = subPath ? subPath.split("/").filter(Boolean) : [];

    if (parts.length === 0) {
      return (
        <ProjectsList refreshToken={refreshToken} navigate={navigate} base={base} />
      );
    }
    if (parts[0] === "new") {
      return <ProjectsNewPage navigate={navigate} onSelectSession={onSelectSession} base={base} />;
    }
    if (parts.length === 2 && (parts[1] === "settings" || parts[1] === "edit")) {
      return <ProjectsSettingsPage projectKey={parts[0]} navigate={navigate} base={base} />;
    }
    return (
      <ProjectsShowPage
        projectKey={parts[0]}
        navigate={navigate}
        onSelectSession={onSelectSession}
        base={base}
      />
    );
  }

  window.ACA.ProjectsCard = ProjectsCard;
})();
