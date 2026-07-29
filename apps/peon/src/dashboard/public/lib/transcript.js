(function () {
  function truncate(text, n) {
    if (!text) return "";
    return text.length > n ? `${text.slice(0, n)}…` : text;
  }

  function toolInputSummary(name, input) {
    if (!input) return "";
    if (input.command) return truncate(input.command, 140);
    if (["Edit", "Write", "Read"].includes(name) && input.file_path) return input.file_path;
    if (name === "Edit" && input.changes) {
      const changes = Array.isArray(input.changes)
        ? input.changes
        : Object.entries(input.changes).map(([path, change]) => ({ path, change }));
      const paths = changes
        .map((change) => change?.path ?? change?.file_path ?? change?.filePath)
        .filter(Boolean);
      if (paths.length > 0) return truncate(paths.join(", "), 140);
      return `${changes.length} file change${changes.length === 1 ? "" : "s"}`;
    }
    const keys = Object.keys(input);
    if (keys.length === 0) return "";
    const first = input[keys[0]];
    return typeof first === "string" ? truncate(first, 140) : truncate(JSON.stringify(input), 140);
  }

  // Upgrade legacy Codex command events at render time too. New sessions get
  // these names from the proxy; old persisted Bash events remain readable.
  function displayToolName(name, input) {
    const aliases = {
      Grep: "Search",
      Glob: "Search",
      WebSearch: "Web",
      WebFetch: "Web",
      Task: "Agent",
    };
    if (aliases[name]) return aliases[name];
    if (name !== "Bash" || typeof input?.command !== "string") return name;
    let command = input.command.replace(/^\s*(?:\/bin\/)?(?:zsh|bash|sh)\s+-lc\s+/, "").trim();
    if ((command.startsWith('"') && command.endsWith('"')) || (command.startsWith("'") && command.endsWith("'"))) {
      command = command.slice(1, -1).trim();
    }
    if (/\n|&&|\|\||;/.test(command)) return name;
    if (/^(?:rg|grep|ag|ack)\b/.test(command)) return "Search";
    if (/^(?:ls|find|fd|tree)\b/.test(command)) return "List";
    if (/^(?:cat|sed|head|tail|less|bat)\b/.test(command)) return "Read";
    if (/^git\b/.test(command)) return "Git";
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|check|typecheck)|pytest\b|cargo\s+test\b|go\s+test\b)/.test(command)) return "Test";
    if (/^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|compile)|tsc\b|cargo\s+build\b|go\s+build\b)/.test(command)) return "Build";
    return name;
  }

  function extractToolResultText(content) {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((c) => (typeof c === "string" ? c : (c.text ?? ""))).join(" ");
    }
    return "";
  }

  function toolFilePaths(name, input) {
    if (!input || !["Edit", "Write", "Read"].includes(name)) return [];
    const candidates = [];
    if (typeof input.file_path === "string") candidates.push(input.file_path);
    if (typeof input.filePath === "string") candidates.push(input.filePath);
    if (name === "Read" && typeof input.path === "string") candidates.push(input.path);
    if (input.changes) {
      const changes = Array.isArray(input.changes)
        ? input.changes
        : Object.entries(input.changes).map(([changePath, change]) => ({ path: changePath, change }));
      for (const change of changes) {
        const changePath = change?.path ?? change?.file_path ?? change?.filePath;
        if (typeof changePath === "string") candidates.push(changePath);
      }
    }
    return [...new Set(candidates.filter((candidate) => candidate.trim()))];
  }

  const PREVIEW_DIRECTIVE = /\[\[peon-preview:\s*([^\]\r\n]+?)\s*\]\]/gi;
  const EXPLICIT_PREVIEW_LINK = /\[\s*Open preview\s*\]\((\/[^)\r\n]+)\)/gi;

  function decodePreviewPath(value) {
    try { return decodeURIComponent(value); } catch { return value; }
  }

  function explicitPreviewLinks(text) {
    return [...text.matchAll(EXPLICIT_PREVIEW_LINK)].map((match) => decodePreviewPath(match[1].trim())).filter(Boolean);
  }

  const AGENT_PREVIEW_EXTENSIONS = new Set([
    "html", "htm", "md", "markdown", "pdf",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico",
  ]);

  function isAgentPreviewArtifact(filePath) {
    const extension = String(filePath ?? "").split(".").pop()?.toLowerCase();
    return AGENT_PREVIEW_EXTENSIONS.has(extension);
  }

  function extractPreviewDirectives(text) {
    const paths = [];
    const visibleText = text.replace(PREVIEW_DIRECTIVE, (_match, filePath) => {
      const trimmed = filePath.trim();
      if (trimmed) paths.push(trimmed);
      return "";
    }).replace(/\n{3,}/g, "\n\n").trim();
    return { visibleText, paths };
  }

  function previewPathsFromEvent(event) {
    const paths = [];
    if (event?.type === "preview" && typeof event.path === "string") {
      if (event.author !== "agent" || isAgentPreviewArtifact(event.path)) paths.push(event.path.trim());
    }
    if (event?.type === "assistant") {
      for (const part of event.message?.content ?? []) {
        if (part.type === "text" && typeof part.text === "string") {
          paths.push(...extractPreviewDirectives(part.text).paths);
          paths.push(...explicitPreviewLinks(part.text));
        }
      }
    }
    if (event?.type === "result" && typeof event.structured_output?.previewPath === "string") {
      paths.push(event.structured_output.previewPath.trim());
    }
    const unique = [...new Set(paths.filter(Boolean))];
    return event?.type === "preview" ? unique : unique.filter(isAgentPreviewArtifact);
  }

  // Providers can emit diagnostics and then continue the turn normally. Keep
  // them in the persisted transcript for debugging, but don't render them as
  // user-actionable chat errors. Filter line-by-line so a real error sharing
  // the same stderr chunk is still shown.
  function visibleProviderStderr(text) {
    const noise = [
      /codex_models_manager::manager: failed to refresh available models: timeout waiting for child process to exit/i,
      /codex_core::util: custom tool call output is missing for call id:/i,
    ];
    return String(text ?? "")
      .split(/\r?\n/)
      .filter((line) => !noise.some((pattern) => pattern.test(line)))
      .join("\n")
      .trim();
  }

  // Flattens the raw agent-event stream (Claude Code stream-json events, or
  // whatever the configured backend emits) into renderable chat items —
  // this is the one place that knows the event shapes; everything below it
  // (SessionTranscript.jsx) only deals in {kind, ...} items.
  //
  // Tool calls and their results are correlated by id into one "tool-step"
  // item (collapsed by default in the UI) rather than two separate flat
  // entries. "system" events (init, thinking_tokens, background subagent
  // lifecycle, etc.) carry nothing worth showing in a default chat view, so
  // they fall through to the default no-op below.
  function transcriptToItems(events) {
    const items = [];
    const toolStepsById = new Map();
    const firstClassPreviewPaths = new Set(
      events.filter((event) => event.type === "preview" && typeof event.path === "string").map((event) => event.path.trim()),
    );

    for (const event of events) {
      switch (event.type) {
        case "user_message":
          items.push({
            kind: "user-text",
            text: event.text,
            permissionMode: event.permissionMode,
            // Per-turn model override (absent unless this message picked a
            // model different from the session default) — surfaced as a badge.
            model: event.model,
            attachments: event.attachments ?? [],
            // Who sent this turn — an authenticated dashboard/CLI user, or
            // "system" for a daemon-injected message. Absent on turns that
            // predate per-user attribution (renders as a generic "You").
            author: event.author ?? null,
          });
          break;
        case "assistant": {
          const parts = event.message?.content ?? [];
          for (const part of parts) {
            if (part.type === "text" && part.text?.trim()) {
              const { visibleText, paths } = extractPreviewDirectives(part.text);
              if (visibleText) items.push({ kind: "assistant-text", text: visibleText });
              for (const filePath of [...paths, ...explicitPreviewLinks(visibleText)]) {
                // New transcripts carry a canonical first-class preview event.
                // Don't also render the textual fallback: on macOS the same
                // file may be written as /var/... in text and /private/var/...
                // after realpath, defeating an exact-string dedupe.
                if (firstClassPreviewPaths.size === 0 && isAgentPreviewArtifact(filePath)) {
                  items.push({ kind: "preview-signal", filePath });
                }
              }
            } else if (part.type === "tool_use" && part.name !== "StructuredOutput") {
              const name = displayToolName(part.name, part.input);
              const step = {
                kind: "tool-step",
                id: part.id,
                name,
                summary: toolInputSummary(name, part.input),
                input: part.input,
                result: null,
                filePaths: toolFilePaths(name, part.input),
              };
              items.push(step);
              toolStepsById.set(part.id, step);
            }
          }
          break;
        }
        case "user": {
          const parts = event.message?.content ?? [];
          for (const part of parts) {
            if (part.type !== "tool_result") continue;
            const step = toolStepsById.get(part.tool_use_id);
            if (!step) continue;
            const text = extractToolResultText(part.content);
            step.result = text && text !== "Structured output provided successfully" ? truncate(text, 2000) : null;
          }
          break;
        }
        case "result": {
          const structured = event.structured_output;
          if (typeof structured?.previewPath === "string" && structured.previewPath.trim()) {
            const filePath = structured.previewPath.trim();
            if (!firstClassPreviewPaths.has(filePath)) items.push({ kind: "preview-signal", filePath });
          }
          if (
            structured &&
            (structured.result === "success" || structured.result === "failure" || structured.result === "needs_human")
          ) {
            items.push({ kind: "outcome", outcome: structured });
          } else if (event.is_error || event.subtype !== "success") {
            // errors[] carries the actual reason for CLI-level failures (e.g.
            // "No conversation found..." from a --resume with nothing to
            // resume) — event.result is usually absent for these, so falling
            // straight to "Unknown error" hid the one useful piece of info.
            const reason = Array.isArray(event.errors) && event.errors.length > 0
              ? event.errors.join("; ")
              : String(event.result ?? "Unknown error");
            items.push({
              kind: "outcome",
              outcome: { result: "failure", summary: reason },
            });
          }
          break;
        }
        case "stderr": {
          const text = visibleProviderStderr(event.text);
          if (text) items.push({ kind: "error", text });
          break;
        }
        case "warning":
          items.push({
            kind: "warning",
            code: event.code,
            message: event.message,
            currentBytes: event.currentBytes,
            limitBytes: event.limitBytes,
            retainedBytes: event.retainedBytes,
            currentTokens: event.currentTokens,
            limitTokens: event.limitTokens,
            action: event.action,
            logPath: event.logPath,
            logError: event.logError,
          });
          break;
        case "preview":
          if (
            typeof event.path === "string" &&
            event.path.trim() &&
            (event.author !== "agent" || isAgentPreviewArtifact(event.path))
          ) {
            items.push({ kind: "preview-signal", filePath: event.path.trim(), name: event.name ?? null, author: event.author ?? null });
          }
          break;
        default:
          break;
      }
    }
    return items;
  }

  Object.assign(window.ACA, { transcriptToItems, toolFilePaths, previewPathsFromEvent });
})();
