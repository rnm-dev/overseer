(function () {
  const { useState } = React;
  const { Badge, formatBytes, Avatar, previewDisplayPath } = window.ACA;

  function renderMarkdown(text) {
    const html = window.marked.parse(text, { breaks: true });
    return { __html: window.DOMPurify.sanitize(html) };
  }

  function AssistantBubble({ text, peonName, onOpenFile }) {
    const openLocalLink = (event) => {
      const anchor = event.target.closest?.("a");
      const href = anchor?.getAttribute("href");
      if (!href || !href.startsWith("/") || href.startsWith("//")) return;
      event.preventDefault();
      onOpenFile?.(decodeURIComponent(href));
    };
    return (
      <div className="flex items-start gap-3">
        <Avatar name={peonName} className="mt-0.5 h-7 w-7 text-sm" />
        <div
          className="prose prose-invert prose-sm max-w-[85%] rounded-sm rounded-tl-sm bg-slate-800 px-4 py-2.5 prose-p:leading-relaxed prose-pre:bg-slate-950"
          onClick={openLocalLink}
          dangerouslySetInnerHTML={renderMarkdown(text)}
        />
      </div>
    );
  }

  // Two-letter monogram for a message author's avatar — first letters of the
  // first two word-parts ("ivan petrov" → "IP"), else the first two chars.
  function authorInitials(name) {
    const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return name.slice(0, 2).toUpperCase();
  }

  function UserBubble({ text, permissionMode, model, attachments = [], author }) {
    // Sessions/turns predating per-user attribution have no author — keep the
    // generic "You" avatar for them. A real author gets a monogram avatar (full
    // name on hover) plus a name caption, so a shared session's transcript makes
    // clear who said what — including the daemon's own "system" turns.
    const avatarLabel = author ? authorInitials(author) : "You";
    return (
      <div className="flex flex-col items-end gap-1.5">
        {author && <span className="pr-9 text-[11px] font-medium text-slate-500">{author}</span>}
        {attachments.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {attachments.map((a, i) => (
              <span
                key={i}
                className="rounded bg-slate-800 px-2 py-1 text-[11px] text-slate-400 ring-1 ring-inset ring-slate-700"
              >
                {a.originalName} · {formatBytes(a.size)}
              </span>
            ))}
          </div>
        )}
        <div className="flex items-start justify-end gap-2">
          {model && (
            <span className="mt-0.5">
              <Badge tone="slate" title="Model used for this message">{model}</Badge>
            </span>
          )}
          {permissionMode === "plan" && (
            <span className="mt-0.5">
              <Badge tone="amber">plan</Badge>
            </span>
          )}
          <div
            className="prose prose-invert prose-sm max-w-[85%] rounded-sm rounded-tr-sm bg-brand-950/60 px-4 py-2.5 text-slate-100 ring-1 ring-inset ring-brand-900 prose-p:leading-relaxed prose-pre:bg-slate-950"
            dangerouslySetInnerHTML={renderMarkdown(text)}
          />
          <div
            title={author || undefined}
            className="mt-0.5 flex h-7 w-7 flex-none items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-slate-200"
          >
            {avatarLabel}
          </div>
        </div>
      </div>
    );
  }

  function ThinkingIndicator({ peonName }) {
    return (
      <div className="flex items-center gap-3">
        <Avatar name={peonName} className="mt-0.5 h-7 w-7 text-sm" />
        <div className="flex items-center gap-1 rounded-sm rounded-tl-sm bg-slate-800 px-4 py-3">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:-0.3s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500 [animation-delay:-0.15s]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-500" />
        </div>
      </div>
    );
  }

  // Tool call + its result, collapsed by default — the "system call spam"
  // that made earlier transcripts unreadable belongs behind a click, not
  // inline in the conversation.
  function ToolStep({ item, onOpenFile }) {
    const [open, setOpen] = useState(false);
    const hasDetail = (item.input && Object.keys(item.input).length > 0) || item.result;
    const icon = {
      Edit: "✎",
      Write: "✎",
      Read: "▤",
      Search: "⌕",
      List: "☷",
      Git: "⑂",
      Test: "✓",
      Build: "◇",
      Web: "◎",
      Agent: "♢",
      Bash: "⚙",
    }[item.name] ?? "⚙";

    return (
      <div className="ml-10 space-y-1">
        <button
          type="button"
          onClick={() => hasDetail && setOpen((o) => !o)}
          className={`flex w-full items-center gap-2 rounded bg-slate-900 px-3 py-1.5 text-left text-xs ring-1 ring-inset ring-slate-800 ${
            hasDetail ? "hover:bg-slate-800/60" : "cursor-default"
          }`}
        >
          <span className="w-3 text-slate-600">{hasDetail ? (open ? "▾" : "▸") : ""}</span>
          <span className="w-3 text-center text-brand-400">{icon}</span>
          <span className="font-medium text-slate-300">{item.name}</span>
          {item.summary && <span className="truncate font-mono text-slate-500">{item.summary}</span>}
        </button>
        {item.filePaths?.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pl-8">
            {item.filePaths.map((filePath) => (
              <button
                key={filePath}
                type="button"
                onClick={() => onOpenFile?.(filePath)}
                title={`Preview ${filePath}`}
                className="max-w-full truncate rounded bg-slate-950 px-2 py-1 font-mono text-[11px] text-brand-400 ring-1 ring-inset ring-slate-800 hover:bg-slate-800 hover:text-brand-300"
              >
                {filePath}
              </button>
            ))}
          </div>
        )}
        {open && hasDetail && (
          <div className="mt-1 space-y-2 rounded bg-slate-950 px-3 py-2 text-xs">
            {item.input && Object.keys(item.input).length > 0 && (
              <pre className="overflow-x-auto whitespace-pre-wrap break-words text-slate-400">
                {JSON.stringify(item.input, null, 2)}
              </pre>
            )}
            {item.result && (
              <div className="border-t border-slate-800 pt-2 text-slate-500">
                <p className="mb-1 text-[10px] text-slate-600">Result</p>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words">{item.result}</pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // Summaries render as markdown (like AssistantBubble) — plain <p> was
  // collapsing genuinely structured multi-paragraph/bulleted reports (real
  // example: a git-auth failure report with headers and a bullet list) into
  // one unbroken blob, since whitespace/newlines aren't preserved by
  // default and there was no markdown parsing at all. Long ones (a real
  // multi-section failure report can run past 1000 characters) also
  // collapse behind a toggle rather than dominating the transcript.
  const OUTCOME_COLLAPSE_THRESHOLD = 400;

  function OutcomeCard({ outcome }) {
    const tone =
      outcome.result === "success" ? "success" : outcome.result === "needs_human" ? "needs_human" : "failure";
    const isLong = outcome.summary.length > OUTCOME_COLLAPSE_THRESHOLD;
    const [expanded, setExpanded] = useState(!isLong);
    const toneClasses = {
      success: { border: "border-emerald-900 bg-emerald-950/40", text: "text-emerald-400", label: "✓ Success" },
      needs_human: { border: "border-amber-900 bg-amber-950/40", text: "text-amber-400", label: "◆ Needs human" },
      failure: { border: "border-red-900 bg-red-950/40", text: "text-red-400", label: "✗ Failure" },
    }[tone];

    return (
      <div className={`rounded-sm border px-4 py-3 ${toneClasses.border}`}>
        <p className={`text-sm font-semibold ${toneClasses.text}`}>{toneClasses.label}</p>
        <div
          className={`prose prose-invert prose-sm mt-1.5 max-w-none text-slate-300 prose-p:my-1.5 prose-p:leading-relaxed prose-headings:text-slate-200 prose-headings:text-sm prose-li:my-0.5 ${
            expanded ? "" : "line-clamp-3"
          }`}
          dangerouslySetInnerHTML={renderMarkdown(outcome.summary)}
        />
        {isLong && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="mt-1 text-xs text-slate-500 underline hover:text-slate-300"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    );
  }

  function WarningCard({ item, live, onOpenFile }) {
    const context = item.code === "context_near_limit";
    const percent = context && item.limitTokens
      ? Math.round((item.currentTokens / item.limitTokens) * 100)
      : item.limitBytes ? Math.round((item.currentBytes / item.limitBytes) * 100) : null;
    return (
      <div className="ml-10 rounded border border-amber-900 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
        <p className="font-medium">⚠ {context ? "Session context" : "Large payload"}{percent != null ? ` · ${percent}%` : ""}</p>
        <p className="mt-1 text-amber-200/80">{item.message}</p>
        {context && item.action === "compact" && (
          <p className="mt-1.5 text-amber-400">
            {live ? "Compact is not started during an active task. Run " : "Run "}
            <code className="rounded bg-amber-950 px-1 py-0.5">/compact</code>
            {live ? " after it finishes." : " before the next large turn."}
          </p>
        )}
        {item.logPath && (
          <button
            type="button"
            onClick={() => onOpenFile?.(item.logPath)}
            className="mt-1.5 max-w-full truncate font-mono text-amber-400 underline hover:text-amber-200"
            title={item.logPath}
          >
            Open full output
          </button>
        )}
        {item.logError && <p className="mt-1 text-red-400">Full log could not be saved.</p>}
      </div>
    );
  }

  function TranscriptItem({ item, peonName, onOpenFile, sessionDir, live }) {
    switch (item.kind) {
      case "assistant-text":
        return <AssistantBubble text={item.text} peonName={peonName} onOpenFile={onOpenFile} />;
      case "user-text":
        return (
          <UserBubble
            text={item.text}
            permissionMode={item.permissionMode}
            model={item.model}
            attachments={item.attachments}
            author={item.author}
          />
        );
      case "tool-step":
        return <ToolStep item={item} onOpenFile={onOpenFile} />;
      case "preview-signal":
        const previewLabel = item.name || previewDisplayPath(item.filePath, sessionDir);
        return (
          <div className="ml-10 flex items-center justify-between gap-3 rounded border border-brand-900 bg-brand-950/30 px-3 py-2">
            <div className="min-w-0">
              <p className="text-[10px] text-brand-500">Prepared for preview</p>
              <p className="truncate font-mono text-xs text-slate-300" title={previewLabel}>{previewLabel}</p>
            </div>
            <button
              type="button"
              onClick={() => onOpenFile?.(item.filePath)}
              className="flex-none text-xs font-medium text-brand-400 hover:text-brand-300"
            >
              Open preview
            </button>
          </div>
        );
      case "error":
        return <div className="ml-10 text-xs text-red-400">⚠ {item.text}</div>;
      case "warning":
        return <WarningCard item={item} live={live} onOpenFile={onOpenFile} />;
      case "outcome":
        return <OutcomeCard outcome={item.outcome} />;
      default:
        return null;
    }
  }

  function SessionTranscript({ events, live, finalOutcome, prompt, peonName, onOpenFile, sessionDir }) {
    const { transcriptToItems } = window.ACA;
    const items = transcriptToItems(events);
    // Sessions started before user_message events existed have no record of
    // what they were asked — backfill just the leading prompt (the one thing
    // we still have via record.prompt) rather than leaving it blank.
    if (prompt && items[0]?.kind !== "user-text") {
      items.unshift({ kind: "user-text", text: prompt });
    }
    // Harness-forced outcomes (timeout, cancel, spawn error, killed before
    // any output) never appear in the event stream itself — confirmed
    // against a real 3-second-timeout session whose transcript was
    // otherwise empty. Without this, the conversation just stops with no
    // visible resolution.
    const includesFinalOutcome = finalOutcome && items.some(
      (item) => item.kind === "outcome" && item.outcome.result === finalOutcome.result && item.outcome.summary === finalOutcome.summary,
    );
    if (finalOutcome && !includesFinalOutcome) {
      items.push({ kind: "outcome", outcome: finalOutcome });
    }
    // Only while genuinely live and not already resolved — items can include
    // the final "outcome" a render or two before the `live` prop (driven by
    // a separate "change" SSE event) catches up, and showing a "thinking"
    // dance under an already-visible outcome card would look broken.
    const showThinking = live && items[items.length - 1]?.kind !== "outcome";
    return (
      <div className="space-y-3">
        {items.length === 0 && !live && <p className="text-sm text-slate-500">No events.</p>}
        {items.map((item, i) => (
          <TranscriptItem key={i} item={item} peonName={peonName} onOpenFile={onOpenFile} sessionDir={sessionDir} live={live} />
        ))}
        {showThinking && <ThinkingIndicator peonName={peonName} />}
      </div>
    );
  }

  window.ACA.SessionTranscript = SessionTranscript;
})();
