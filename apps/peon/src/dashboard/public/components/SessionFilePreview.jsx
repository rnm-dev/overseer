(function () {
  const { useCallback, useEffect, useMemo, useState } = React;
  const { API_BASE, apiGet, formatBytes, previewDisplayPath } = window.ACA;

  function markdownHtml(content) {
    return { __html: window.DOMPurify.sanitize(window.marked.parse(content, { breaks: true })) };
  }

  function SessionFilePreview({ sessionId, filePath, following, onFollow, onClose, sessionDir }) {
    const [data, setData] = useState(null);
    const [error, setError] = useState(null);
    const [revision, setRevision] = useState(0);
    const [renderedMarkdown, setRenderedMarkdown] = useState(false);
    const [renderedHtml, setRenderedHtml] = useState(true);
    const [expanded, setExpanded] = useState(false);

    const load = useCallback(async () => {
      if (!filePath) return;
      const { ok, body } = await apiGet(`/api/v1/sessions/${sessionId}/file?path=${encodeURIComponent(filePath)}`);
      if (ok) {
        setData(body);
        setError(null);
      } else {
        setData(null);
        setError(body.error ?? "failed to open file");
      }
    }, [sessionId, filePath]);

    useEffect(() => {
      setData(null);
      setError(null);
      setRenderedMarkdown(false);
      setRenderedHtml(true);
      load();
    }, [load]);

    useEffect(() => {
      if (!filePath) return;
      const url = `${API_BASE}/api/v1/sessions/${sessionId}/file/stream?path=${encodeURIComponent(filePath)}`;
      const es = new EventSource(url, { withCredentials: true });
      es.addEventListener("changed", () => {
        setRevision((value) => value + 1);
        load();
      });
      return () => es.close();
    }, [sessionId, filePath, load]);

    useEffect(() => {
      if (!expanded) return;
      const collapse = (event) => {
        if (event.key === "Escape") setExpanded(false);
      };
      window.addEventListener("keydown", collapse);
      return () => window.removeEventListener("keydown", collapse);
    }, [expanded]);

    const extension = filePath.split(".").pop()?.toLowerCase() ?? "";
    const isMarkdown = extension === "md" || extension === "markdown";
    const isHtml = extension === "html" || extension === "htm";
    const imageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);
    const isImage = imageExtensions.has(extension);
    const isPdf = extension === "pdf";
    const rawUrl = `${API_BASE}/api/v1/sessions/${sessionId}/file/raw?path=${encodeURIComponent(filePath)}&v=${data?.mtimeMs ?? ""}`;
    const fileLabel = previewDisplayPath(filePath, sessionDir);
    const lines = useMemo(() => (data?.content ?? "").split("\n"), [data?.content, revision]);

    return (
      <>
      {expanded && (
        <button
          type="button"
          aria-label="Collapse preview"
          onClick={() => setExpanded(false)}
          className="fixed inset-0 z-40 cursor-default bg-black/80"
        />
      )}
      <section className={`flex min-h-0 flex-col overflow-hidden rounded-sm border border-slate-800 bg-slate-900 ${expanded ? "fixed inset-3 z-50 md:inset-12" : ""}`}>
        <header className="flex flex-none items-center gap-2 border-b border-slate-800 px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200" title={fileLabel}>{fileLabel}</span>
          {(isMarkdown || isHtml) && data?.content != null && (
            <button
              type="button"
              onClick={() => isHtml ? setRenderedHtml((value) => !value) : setRenderedMarkdown((value) => !value)}
              className="text-[11px] text-slate-400 hover:text-slate-200"
            >
              {isHtml ? (renderedHtml ? "Source" : "Preview") : (renderedMarkdown ? "Source" : "Render")}
            </button>
          )}
          {!following && (
            <button type="button" onClick={onFollow} className="text-[11px] text-brand-400 hover:text-brand-300">
              Follow previews
            </button>
          )}
          {following && <span className="text-[10px] text-slate-500">following</span>}
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            title={expanded ? "Collapse preview" : "Expand preview"}
            className="text-sm text-slate-500 hover:text-slate-200"
          >
            {expanded ? "⤢" : "⛶"}
          </button>
          <button type="button" onClick={onClose} title="Close preview" className="text-slate-500 hover:text-slate-200">×</button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto">
          {!data && !error && <p className="p-4 text-sm text-slate-500">Loading…</p>}
          {error && <p className="p-4 text-sm text-red-400">{error}</p>}
          {data?.truncated && !isImage && (
            <div className="flex items-center justify-between gap-3 border-b border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-400">
              <span>Showing the first 2 MB of {formatBytes(data.size)}.</span>
              <a href={rawUrl} target="_blank" rel="noreferrer" className="flex-none font-medium underline hover:text-amber-200">
                Open full raw file
              </a>
            </div>
          )}
          {data && isImage && (
            <div className="flex min-h-full items-center justify-center p-4">
              <img
                src={rawUrl}
                alt={filePath}
                className="max-h-full max-w-full object-contain"
              />
            </div>
          )}
          {data && isPdf && (
            <iframe src={rawUrl} title={filePath} className="h-full min-h-[32rem] w-full bg-white" />
          )}
          {data?.content != null && isHtml && renderedHtml && (
            <iframe
              src={`${API_BASE}/api/v1/sessions/${sessionId}/file/web?path=${encodeURIComponent(filePath)}&v=${data.mtimeMs}`}
              title={filePath}
              sandbox="allow-scripts allow-forms allow-modals allow-downloads"
              className="h-full min-h-[32rem] w-full bg-white"
            />
          )}
          {data && data.binary && !isImage && !isPdf && (
            <div className="p-4 text-sm text-slate-500">
              <p>Binary file ({formatBytes(data.size)}) — no visual renderer is available.</p>
              <a href={rawUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-brand-400 hover:text-brand-300">
                Open raw file
              </a>
            </div>
          )}
          {data?.content != null && !isPdf && !isHtml && isMarkdown && renderedMarkdown && (
            <div
              className="prose prose-invert prose-sm max-w-none p-4 prose-pre:bg-slate-950"
              dangerouslySetInnerHTML={markdownHtml(data.content)}
            />
          )}
          {data?.content != null && !isPdf && (!isHtml || !renderedHtml) && (!isMarkdown || !renderedMarkdown) && (
            <div className="min-w-max py-3 font-mono text-xs leading-5">
              {lines.map((line, index) => (
                <div key={index} className="flex px-3 hover:bg-slate-800/40">
                  <span className="mr-4 w-10 flex-none select-none text-right text-slate-600">{index + 1}</span>
                  <span className="whitespace-pre text-slate-300">{line || " "}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        {data && (
          <footer className="flex-none border-t border-slate-800 px-3 py-1.5 text-[10px] text-slate-600">
            Current file · {formatBytes(data.size)}
          </footer>
        )}
      </section>
      </>
    );
  }

  window.ACA.SessionFilePreview = SessionFilePreview;
})();
