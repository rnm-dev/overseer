import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, ApiError, isPeonNeedsUpdate, json } from "../../api";
import { Badge, Button, Input } from "../../ui";
import { useT } from "../../i18n";
import { useLiveSocket, type TailFrame } from "../../liveSocket";
import { usePeon } from "./context";
import { ModelSelect, modelLabel, useModels, type SessionUsage } from "./models";

// author: Viktor

type T = ReturnType<typeof useT>;

// Claude Code stream-json transcript events (also what the live tail emits).
interface Block {
  type?: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
  is_error?: boolean;
}
interface Ev {
  type?: string;
  text?: string;
  author?: string;
  message?: { role?: string; content?: Block[] | string };
  model?: string;
  cwd?: string;
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  content?: unknown;
  [k: string]: unknown;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === "object" ? String((c as { text?: unknown }).text ?? "") : typeof c === "string" ? c : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
function toolSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const v = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? i.prompt ?? i.query;
  return typeof v === "string" ? v : "";
}
// Structural signature for de-duping the snapshot/tail overlap (events carry no
// stable id). The peon serializes the same event identically on both channels, so
// stringify equality is a reliable match.
const sig = (ev: Ev): string => JSON.stringify(ev);

function UserBubble({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] whitespace-pre-wrap break-words rounded-xl rounded-br-sm border border-fel/25 bg-fel/[0.12] px-3 py-1.5 text-sm leading-normal text-bone">{text}</div>
    </div>
  );
}

// Minimal, dependency-free Markdown → JSX for assistant messages. Covers the
// GFM subset agents emit: fenced code, headings, lists, blockquotes, inline
// code/bold/italic/links. (No `_italic_` — snake_case in code/paths is common.)
function inline(text: string): ReactNode[] {
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) nodes.push(<code key={key++} className="rounded bg-iron-900 px-1 py-0.5 font-mono text-[0.85em] text-forge">{tok.slice(1, -1)}</code>);
    else if (tok.startsWith("**")) nodes.push(<strong key={key++} className="font-semibold text-bone">{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("*")) nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    else {
      const mm = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok)!;
      nodes.push(<a key={key++} href={mm[2]} target="_blank" rel="noreferrer" className="text-fel-bright underline">{mm[1]}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const isBlockStart = (l: string) => /^```/.test(l.trim()) || /^#{1,6}\s/.test(l) || /^>\s?/.test(l) || /^\s*[-*]\s+/.test(l) || /^\s*\d+\.\s+/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line.trim())) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      i++;
      out.push(<pre key={key++} className="overflow-x-auto rounded bg-iron-900/70 p-2.5 font-mono text-xs leading-relaxed text-bone-dim"><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { out.push(<div key={key++} className="font-display text-sm font-bold text-bone">{inline(h[1])}</div>); i++; continue; }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      out.push(<blockquote key={key++} className="border-l-2 border-iron-700 pl-3 text-bone-dim">{inline(buf.join("\n"))}</blockquote>);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s+/, ""));
      out.push(<ul key={key++} className="list-disc space-y-0.5 pl-5">{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
      out.push(<ol key={key++} className="list-decimal space-y-0.5 pl-5">{items.map((it, k) => <li key={k}>{inline(it)}</li>)}</ol>);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) buf.push(lines[i++]);
    out.push(<p key={key++} className="whitespace-pre-wrap break-words">{inline(buf.join("\n"))}</p>);
  }
  return <div className="space-y-1.5">{out}</div>;
}

function Notice({ tone, children }: { tone?: "neutral" | "error"; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-iron-800" />
      <span className={`font-mono text-[0.7rem] ${tone === "error" ? "text-blood" : "text-bone-faint"}`}>{children}</span>
      <div className="h-px flex-1 bg-iron-800" />
    </div>
  );
}

function Action({ name, input }: { name?: string; input?: unknown }) {
  const summary = toolSummary(input);
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded border border-iron-800 bg-iron-900/40 px-3 py-2 font-mono text-xs">
        <span className="text-fel-bright">⚙ {name || "tool"}</span>
        {summary && <div className="mt-1 whitespace-pre-wrap break-words text-bone-dim">{summary}</div>}
      </div>
    </div>
  );
}

function ActionResult({ text, error, t }: { text: string; error?: boolean; t: T }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 300;
  const shown = open || !long ? text : text.slice(0, 300) + "…";
  if (!text.trim()) return null;
  return (
    <div className="flex justify-start">
      <div className={`max-w-[85%] border-l-2 pl-3 font-mono text-xs ${error ? "border-blood/60 text-blood" : "border-iron-700 text-bone-faint"}`}>
        <pre className="whitespace-pre-wrap break-words">{shown}</pre>
        {long && (
          <button onClick={() => setOpen(!open)} className="mt-1 text-bone-dim transition-colors hover:text-fel-bright">
            {open ? t("session.chat.less") : t("session.chat.more")}
          </button>
        )}
      </div>
    </div>
  );
}

function Thinking({ text, t }: { text: string; t: T }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] text-xs">
        <button onClick={() => setOpen(!open)} className="font-mono text-bone-faint transition-colors hover:text-bone-dim">
          ✦ {t("session.chat.thinking")} {open ? "▾" : "▸"}
        </button>
        {open && <pre className="mt-1 whitespace-pre-wrap break-words border-l-2 border-iron-800 pl-3 italic text-bone-faint">{text}</pre>}
      </div>
    </div>
  );
}

function AssistantBlock({ b, t }: { b: Block; t: T }) {
  // Assistant prose is full-width markdown.
  if (b.type === "text" && b.text?.trim()) return <div className="text-sm leading-relaxed text-bone"><Markdown source={b.text} /></div>;
  if (b.type === "thinking" && b.thinking?.trim()) return <Thinking text={b.thinking} t={t} />;
  if (b.type === "tool_use") return <Action name={b.name} input={b.input} />;
  return null;
}

function ChatEvent({ ev, t }: { ev: Ev; t: T }) {
  switch (ev.type) {
    case "user_message":
      return <UserBubble text={ev.text || ""} />;
    case "assistant": {
      const blocks = Array.isArray(ev.message?.content) ? (ev.message!.content as Block[]) : [];
      return (
        <>
          {blocks.map((b, i) => (
            <AssistantBlock key={i} b={b} t={t} />
          ))}
        </>
      );
    }
    case "user": {
      // Tool results are fed back as a user-role message per the Anthropic API.
      const blocks = Array.isArray(ev.message?.content) ? (ev.message!.content as Block[]) : [];
      return (
        <>
          {blocks.map((b, i) =>
            b.type === "tool_result" ? <ActionResult key={i} text={textFromContent(b.content)} error={!!b.is_error} t={t} /> : b.type === "text" && b.text ? <ActionResult key={i} text={b.text} t={t} /> : null,
          )}
        </>
      );
    }
    case "system":
      // Auto-resume re-inits the agent, so these repeat constantly — too noisy.
      return null;
    case "result": {
      const parts = [ev.is_error ? t("session.chat.failed") : t("session.chat.ended")];
      if (typeof ev.num_turns === "number") parts.push(t("session.chat.turns", { n: ev.num_turns }));
      if (typeof ev.duration_ms === "number") parts.push(`${Math.round(ev.duration_ms / 1000)}s`);
      if (typeof ev.total_cost_usd === "number") parts.push(`$${ev.total_cost_usd.toFixed(2)}`);
      return <Notice tone={ev.is_error ? "error" : "neutral"}>{parts.join(" · ")}</Notice>;
    }
    case "rate_limit_event":
      return null;
    case "_raw":
      return <div className="whitespace-pre-wrap break-words font-mono text-xs text-bone-dim">{ev.text}</div>;
    default: {
      const text = ev.text ?? textFromContent(ev.content);
      return text ? <div className="whitespace-pre-wrap break-words font-mono text-xs text-bone-faint">{text}</div> : null;
    }
  }
}

// Contextual "agent is working" label from the freshest transcript event — so the
// operator sees *what* it's doing (running a command, reading a file…), not just a spinner.
function toolActivity(name?: string): { key: string; name?: string } {
  switch (name) {
    case "Bash":
      return { key: "session.working.bash" };
    case "Read":
      return { key: "session.working.read" };
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return { key: "session.working.edit" };
    case "Grep":
    case "Glob":
      return { key: "session.working.search" };
    case "WebFetch":
    case "WebSearch":
      return { key: "session.working.web" };
    case "Task":
    case "Agent":
      return { key: "session.working.subagent" };
    default:
      return { key: "session.working.tool", name: name || "tool" };
  }
}
function workingActivity(last: Ev | undefined): { key: string; name?: string } {
  if (last?.type === "assistant") {
    const blocks = Array.isArray(last.message?.content) ? (last.message!.content as Block[]) : [];
    const b = [...blocks].reverse().find((x) => x.type === "tool_use" || (x.type === "text" && !!x.text?.trim()));
    if (b?.type === "tool_use") return toolActivity(b.name);
    if (b?.type === "text") return { key: "session.working.typing" };
  }
  return { key: "session.working.thinking" };
}

function Working({ label }: { label: string }) {
  return (
    <div className="flex justify-start">
      <div className="reveal flex items-center gap-2.5 rounded-xl border border-fel/20 bg-fel/[0.06] px-3 py-2 text-sm text-bone-dim">
        <span className="thinking-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
        {label}
      </div>
    </div>
  );
}

// Types the peon presents as visual content via the agent's Read tool → sent as
// { type: "image" }. Everything else is a { type: "file" } the agent Reads as text.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 10;
// Default upload sandbox — auto-set on a peon that has file transfer off, so
// attaching works without a manual Settings step. Uploads land under here.
const DEFAULT_FILE_ROOT = "/tmp/peon-files";
const compactNum = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
// Compact spend for a model: prefer cost, fall back to token count.
const usageLabel = (u: SessionUsage): string => (typeof u.totalCostUsd === "number" ? `$${u.totalCostUsd.toFixed(2)}` : typeof u.totalTokens === "number" ? compactNum.format(u.totalTokens) : "");
const isImage = (f: File) => IMAGE_TYPES.has(f.type);
// Friendly chip label — pasted screenshots have a machine name; show a short one.
const chipName = (f: File) => (/^pasted-\d+/.test(f.name) ? "Pasted image" : f.name);

export function PeonSessionDetail() {
  const t = useT();
  const { peon, base } = usePeon();
  const { sid = "" } = useParams();
  const { subscribe } = useLiveSocket();
  const navigate = useNavigate();
  const { catalog, supported: modelsSupported } = useModels(base);

  const [history, setHistory] = useState<Ev[] | null>(null);
  const [live, setLive] = useState<Ev[]>([]);
  const [tail, setTail] = useState<"open" | "ended" | "error">("open");

  // Session title + inline rename.
  const [title, setTitle] = useState<string | null>(null);
  const [projectKey, setProjectKey] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [renameNote, setRenameNote] = useState<string | null>(null);

  // eventCount is optional (older peons omit it) — undefined ⇒ "unknown", not 0.
  const [eventCount, setEventCount] = useState<number | undefined>(undefined);

  // Session default model (null ⇒ follows the peon's global default) + spend per
  // model. Both come from the session record; refetched when a run ends (metaTick).
  const [sessionModel, setSessionModel] = useState<string | null>(null);
  const [usageByModel, setUsageByModel] = useState<Record<string, SessionUsage>>({});
  const [metaTick, setMetaTick] = useState(0);
  // Per-turn model override for the composer ("" ⇒ use the session/peon default).
  const [overrideModel, setOverrideModel] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteNote, setDeleteNote] = useState<string | null>(null);

  // Whether a run is currently active — gates the Stop button. Seeded from the
  // session record, flipped on by sending a followup, off by a `result` frame.
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopNote, setStopNote] = useState<string | null>(null);

  // Composer.
  const [input, setInput] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [filesEnabled, setFilesEnabled] = useState<boolean | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  // Object URLs for image thumbnails; revoked when the file set changes/unmounts.
  const previews = useMemo(() => files.map((f) => (isImage(f) ? URL.createObjectURL(f) : null)), [files]);
  useEffect(() => () => previews.forEach((u) => u && URL.revokeObjectURL(u)), [previews]);
  // Prompts we just sent + echoed optimistically — used to drop the SSE replay if
  // the peon also emits them, so a sent message never shows twice.
  const sentTextsRef = useRef<Set<string>>(new Set());
  // The initial /transcript snapshot and the live tail overlap: the tail attaches
  // just before the snapshot is taken, so events in that window arrive on both
  // channels. These drive a filter that skips the leading run of tail events that
  // merely replay the snapshot, until the first genuinely-new event.
  const historyReadyRef = useRef(false);
  // Signatures of every event already shown (history + everything appended live).
  // The live tail is deduped against this continuously — not just at the initial
  // snapshot boundary — so a peon replay after a WS reconnect or the same frame
  // arriving twice can't re-append. Distinct events have distinct JSON
  // (uuid/timestamps), so this never collapses two genuinely-different messages.
  const seenRef = useRef<Set<string>>(new Set());
  const pendingLiveRef = useRef<Ev[]>([]);

  // Append a live tail event, dropping the leading run that just replays the
  // snapshot. Once a tail event isn't found in the snapshot the overlap is past and
  // everything after is appended verbatim — so a legitimately repeated message
  // later in the session is never dropped.
  const pushLive = useCallback((ev: Ev) => {
    const s = sig(ev);
    if (seenRef.current.has(s)) return; // already shown — snapshot/tail overlap or a reconnect replay
    seenRef.current.add(s);
    setLive((prev) => [...prev, ev]);
  }, []);

  // Whether file transfer is enabled on the peon. If it's off, auto-enable a
  // default /tmp sandbox so attaching just works (no manual Settings step).
  useEffect(() => {
    let alive = true;
    api<{ filesEnabled?: boolean }>(`${base}/status`)
      .then(async (s) => {
        if (!alive) return;
        if (s.filesEnabled) return setFilesEnabled(true);
        try {
          await api(`${base}/settings`, { method: "PATCH", body: JSON.stringify({ fileTransferRoot: DEFAULT_FILE_ROOT }) });
          if (alive) setFilesEnabled(true);
        } catch {
          if (alive) setFilesEnabled(false);
        }
      })
      .catch(() => alive && setFilesEnabled(false));
    return () => {
      alive = false;
    };
  }, [base]);

  // Upload one file to the peon sandbox (under fileTransferRoot/uploads/<sid>/).
  // Returns the committed path the peon reports.
  async function uploadFile(f: File): Promise<string> {
    const safe = f.name.replace(/[^\w.\-]+/g, "_") || "file";
    const buf = await f.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await api<{ path?: string }>(`${base}/files/uploads/${encodeURIComponent(sid)}/${encodeURIComponent(safe)}`, {
      method: "PUT",
      body: buf,
      headers: { "content-type": "application/octet-stream", "peon-content-sha256": hex },
    });
    return res.path || `uploads/${sid}/${safe}`;
  }

  function addFiles(picked: File[]) {
    const ok = picked.filter((f) => f.size <= MAX_FILE_BYTES);
    setFiles((prev) => [...prev, ...ok].slice(0, MAX_FILES));
    setSendError(ok.length < picked.length ? t("session.compose.tooLarge") : files.length + ok.length > MAX_FILES ? t("session.compose.tooMany") : null);
  }

  async function send() {
    const text = input.trim();
    if ((!text && files.length === 0) || sending) return;
    setSending(true);
    setSendError(null);
    try {
      // Upload each file to the sandbox, then send native attachments[] (peon
      // presents images as visual content to the agent via its Read tool).
      const attachments: { type: "file" | "image"; path: string }[] = [];
      for (const f of files) attachments.push({ type: isImage(f) ? "image" : "file", path: await uploadFile(f) });
      const prompt = text || "(see attachments)";
      const body: { prompt: string; attachments?: typeof attachments; model?: string } = { prompt };
      if (attachments.length) body.attachments = attachments;
      if (overrideModel) body.model = overrideModel; // one-shot override for this turn
      await api(`${base}/sessions/${encodeURIComponent(sid)}/followup`, json(body));
      sentTextsRef.current.add(prompt);
      setLive((prev) => [...prev, { type: "user_message", text: prompt }]);
      setRunning(true);
      setStopNote(null);
      setInput("");
      setFiles([]);
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      if (err instanceof ApiError && (code === "RESUME_IN_PROGRESS" || err.status === 409)) setSendError(t("session.compose.busy"));
      else if (code === "FILES_DISABLED") setSendError(t("session.compose.filesDisabledHint"));
      else if (code === "ATTACHMENT_TOO_LARGE") setSendError(t("session.compose.tooLarge"));
      else if (code === "UNSUPPORTED_MEDIA_TYPE") setSendError(t("session.compose.badType"));
      else if (code === "UNKNOWN_ATTACHMENT_PATH" || code === "PATH_ESCAPE") setSendError(t("session.compose.uploadFailed"));
      else if (isPeonNeedsUpdate(err)) setSendError(t("peon.unsupported"));
      else setSendError(err instanceof ApiError ? err.message : t("error.generic"));
    } finally {
      setSending(false);
    }
  }

  useEffect(() => {
    let alive = true;
    api<{ title?: string | null; eventCount?: number; projectKey?: string | null; status?: string | null; model?: string | null; usageByModel?: Record<string, SessionUsage> }>(
      `${base}/sessions/${encodeURIComponent(sid)}`,
    )
      .then((s) => {
        if (!alive) return;
        setTitle(s.title ?? null);
        setProjectKey(s.projectKey ?? null);
        setEventCount(typeof s.eventCount === "number" ? s.eventCount : undefined);
        if (metaTick === 0) setRunning(s.status === "running"); // seed once; the tail owns it after
        setSessionModel(s.model ?? null);
        setUsageByModel(s.usageByModel ?? {});
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [base, sid, metaTick]);

  async function remove() {
    setDeleting(true);
    setDeleteNote(null);
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "DELETE" });
      navigate("..", { relative: "path" });
    } catch (err) {
      // 409 ⇒ still running (cancel first); 404 on an older peon ⇒ needs update.
      setDeleteNote(err instanceof ApiError && err.status === 409 ? t("session.delete.running") : isPeonNeedsUpdate(err) ? t("peon.unsupported") : t("error.generic"));
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  async function stop() {
    setStopping(true);
    setStopNote(null);
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}/cancel`, { method: "POST" });
      setRunning(false);
    } catch (err) {
      // 409 ⇒ nothing active to cancel; 404 on an older peon ⇒ needs update.
      setStopNote(err instanceof ApiError && err.status === 409 ? t("session.stop.nothing") : isPeonNeedsUpdate(err) ? t("peon.unsupported") : t("error.generic"));
    } finally {
      setStopping(false);
    }
  }

  async function saveName() {
    setSavingName(true);
    setRenameNote(null);
    const next = draft.trim() ? draft.trim() : null; // empty clears the title
    try {
      await api(`${base}/sessions/${encodeURIComponent(sid)}`, { method: "PATCH", body: JSON.stringify({ title: next }) });
      setTitle(next);
      setEditing(false);
    } catch (err) {
      // Older peons predate PATCH /sessions/:id → 404; surface "needs update".
      setRenameNote(isPeonNeedsUpdate(err) ? t("peon.unsupported") : t("error.generic"));
    } finally {
      setSavingName(false);
    }
  }

  // Initial transcript. Also the reset point for the snapshot/tail overlap state:
  // switching sessions clears the live buffer and re-seeds the overlap filter.
  useEffect(() => {
    let alive = true;
    historyReadyRef.current = false;
    seenRef.current = new Set();
    pendingLiveRef.current = [];
    setHistory(null);
    setLive([]);
    const ready = (events: Ev[]) => {
      setHistory(events);
      seenRef.current = new Set(events.map(sig));
      historyReadyRef.current = true;
      // Replay any tail frames that landed before the snapshot, through the same
      // overlap filter now that the baseline exists.
      const pending = pendingLiveRef.current;
      pendingLiveRef.current = [];
      for (const ev of pending) pushLive(ev);
    };
    api<{ events?: Ev[] } | Ev[]>(`${base}/sessions/${encodeURIComponent(sid)}/transcript`)
      .then((r) => alive && ready(Array.isArray(r) ? r : (r.events ?? [])))
      .catch(() => alive && ready([]));
    return () => {
      alive = false;
    };
  }, [base, sid, pushLive]);

  // Live tail over the WebSocket — same event shape as the transcript.
  useEffect(() => {
    const onFrame = (f: TailFrame) => {
      if (f.event === "tailEnd") return setTail("ended");
      if (f.event === "tailError") return setTail("error");
      let ev: Ev;
      try {
        ev = JSON.parse(f.data) as Ev;
      } catch {
        ev = { type: "_raw", text: f.data };
      }
      // A run just finished (completed, cancelled, or failed) — retire the Stop
      // button and refetch session meta so model spend (usageByModel) catches up.
      if (ev.type === "result") {
        setRunning(false);
        setMetaTick((n) => n + 1);
      }
      // Skip the SSE replay of a message we already echoed optimistically. Record
      // the real frame's signature so a later replay (reconnect re-tail) is dropped
      // by seenRef instead of slipping past the now-consumed one-shot text guard.
      if (ev.type === "user_message" && typeof ev.text === "string" && sentTextsRef.current.has(ev.text)) {
        sentTextsRef.current.delete(ev.text);
        seenRef.current.add(sig(ev));
        return;
      }
      // Tail frames can arrive before the transcript snapshot resolves; buffer them
      // so the overlap filter has a baseline to compare against.
      if (!historyReadyRef.current) {
        pendingLiveRef.current.push(ev);
        return;
      }
      pushLive(ev);
    };
    const unsub = subscribe(peon.peonId, sid, onFrame);
    return unsub;
  }, [peon.peonId, sid, subscribe, pushLive]);

  // Autoscroll to the newest output — always snap to the bottom on a new frame,
  // even if the operator scrolled up. rAF so freshly-laid-out content (code
  // blocks, tool output, images) is measured before we jump, or we'd land short.
  useEffect(() => {
    const id = requestAnimationFrame(() => window.scrollTo({ top: document.documentElement.scrollHeight }));
    return () => cancelAnimationFrame(id);
  }, [history, live]);

  const tailTone = tail === "open" ? "green" : tail === "ended" ? "neutral" : "red";
  const tailLabel = tail === "open" ? t("session.tail.live") : tail === "ended" ? t("session.tail.ended") : t("session.tail.error");

  // What the agent is doing right now, from the freshest event (live wins over history).
  const lastEvent = live.length ? live[live.length - 1] : history?.length ? history[history.length - 1] : undefined;
  const working = workingActivity(lastEvent);

  return (
    <div>
      {/* header — pinned to the top; the chat scrolls beneath it */}
      <div className="sticky top-0 z-20 -mx-6 border-b border-iron-800 bg-void px-6 pb-2.5 pt-2">
        <div className="relative space-y-1.5">
          <div className="pointer-events-none absolute right-0 top-0 z-10">
            <Badge tone={tailTone}>{tailLabel}</Badge>
          </div>

          <div className="flex items-center gap-4 pr-24">
            <Link to=".." relative="path" className="font-mono text-xs text-bone-dim hover:text-fel-bright">
              {t("session.back")}
            </Link>
            {running && (
              <button
                className="flex items-center gap-1.5 font-mono text-xs text-ember transition-colors hover:text-blood disabled:opacity-40"
                onClick={stop}
                disabled={stopping}
              >
                <span className="text-[0.6rem] leading-none">■</span>
                {stopping ? t("session.stop.stopping") : t("session.stop")}
              </button>
            )}
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-blood">{t("session.delete.confirm")}</span>
                <Button size="sm" variant="iron" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  {t("action.cancel")}
                </Button>
                <button className="btn btn-sm !border-blood/50 !text-blood hover:!bg-blood/10" onClick={remove} disabled={deleting}>
                  {deleting ? t("session.delete.deleting") : t("session.delete.confirmYes")}
                </button>
              </div>
            ) : (
              <button className="font-mono text-xs text-bone-dim transition-colors hover:text-blood" onClick={() => { setDeleteNote(null); setConfirmDelete(true); }}>
                {t("session.delete")}
              </button>
            )}
          </div>

          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-xs"
                value={draft}
                autoFocus
                placeholder={t("session.renamePlaceholder")}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") saveName();
                  if (e.key === "Escape") setEditing(false);
                }}
              />
              <Button size="sm" onClick={saveName} disabled={savingName}>
                {savingName ? t("peon.settings.saving") : t("session.rename.save")}
              </Button>
              <Button size="sm" variant="iron" onClick={() => setEditing(false)} disabled={savingName}>
                {t("action.cancel")}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-1 font-mono text-xs text-bone-faint">
              {sid}
              {projectKey && (
                <Link
                  to={`/peons/${peon.peonId}/projects/${encodeURIComponent(projectKey)}`}
                  className="ml-1 rounded bg-iron-800 px-1.5 py-0.5 text-[0.7rem] text-bone-dim transition-colors hover:text-fel-bright"
                  title={t("session.project")}
                >
                  {projectKey}
                </Link>
              )}
              {eventCount !== undefined && <span className="ml-1">· {t("session.events", { n: eventCount })}</span>}
              {sessionModel && <span className="ml-1" title={t("session.model")}>· {modelLabel(catalog, sessionModel) ?? sessionModel}</span>}
              {Object.entries(usageByModel)
                .filter(([, u]) => usageLabel(u))
                .map(([id, u]) => (
                  <span key={id} className="ml-1 text-bone-dim" title={t("session.usage.by")}>
                    · {modelLabel(catalog, id) ?? id} {usageLabel(u)}
                  </span>
                ))}
              <button className="ml-2 text-bone-dim transition-colors hover:text-fel-bright" onClick={() => { setDraft(title ?? ""); setRenameNote(null); setEditing(true); }}>
                · {t("session.rename")}
              </button>
            </div>
          )}
          {renameNote && <div className="font-mono text-xs text-blood">{renameNote}</div>}
          {deleteNote && <div className="font-mono text-xs text-blood">⚠ {deleteNote}</div>}
          {stopNote && <div className="font-mono text-xs text-ember">⚠ {stopNote}</div>}
        </div>
      </div>

      {/* transcript — flows into the page; the body scrolls it */}
      <div className="pb-44 pt-4">
        {history === null ? (
          <div className="forge-spin" />
        ) : history.length === 0 && live.length === 0 && !running ? (
          <p className="text-center font-mono text-sm text-bone-faint">{t("session.empty")}</p>
        ) : (
          <div className="space-y-2.5">
            {history.map((ev, i) => (
              <ChatEvent key={`h${i}`} ev={ev} t={t} />
            ))}
            {live.map((ev, i) => (
              <ChatEvent key={`l${i}`} ev={ev} t={t} />
            ))}
            {running && tail === "open" && <Working label={t(working.key, working.name ? { name: working.name } : undefined)} />}
          </div>
        )}
      </div>

      {/* composer — portaled to <body> so it's truly viewport-fixed (the .reveal
          transform would otherwise make `fixed` resolve against it), pinned to the
          bottom, boxed, and slightly wider than the chat column */}
      {createPortal(
        <div className="fixed bottom-0 left-60 right-0 z-20 bg-gradient-to-t from-void via-void to-transparent pt-8">
          <div className="mx-auto max-w-[76rem] px-6 pb-5">
          <div className="rounded-2xl border border-iron-700 bg-iron-900/95 px-2 py-1.5 shadow-[0_-6px_28px_-14px_rgba(0,0,0,0.8)] backdrop-blur transition-colors focus-within:border-fel-deep">
            {sendError && <div className="px-2 pb-1 pt-0.5 font-mono text-xs text-blood">⚠ {sendError}</div>}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-1 pb-1.5 pt-1">
                {files.map((f, i) => (
                  <span key={i} className="flex items-center gap-1.5 rounded-md border border-iron-700 bg-iron-950 py-1 pl-1.5 pr-2 font-mono text-xs text-bone-dim">
                    {previews[i] ? (
                      <button type="button" title={t("session.compose.preview")} onClick={() => setPreview(previews[i])} className="block h-4 w-4 shrink-0 overflow-hidden rounded-sm">
                        <img src={previews[i]!} alt="" className="h-full w-full object-cover" />
                      </button>
                    ) : (
                      <svg className="shrink-0 text-bone-faint" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
                        <path d="M14 2v6h6" />
                      </svg>
                    )}
                    <span className="max-w-[130px] truncate" title={f.name}>{chipName(f)}</span>
                    <button className="shrink-0 text-bone-faint transition-colors hover:text-blood" onClick={() => setFiles(files.filter((_, j) => j !== i))} disabled={sending}>
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {modelsSupported && catalog && catalog.providers.length > 0 && (
              <div className="flex justify-end px-1 pb-1.5 pt-0.5">
                <ModelSelect
                  catalog={catalog}
                  value={overrideModel}
                  onChange={setOverrideModel}
                  defaultLabel={(() => {
                    const eff = sessionModel ?? catalog.defaultModel;
                    return eff ? `${t("model.default")} · ${modelLabel(catalog, eff)}` : t("model.default");
                  })()}
                />
              </div>
            )}
            <div className="flex items-end gap-1">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                title={filesEnabled ? t("session.compose.attach") : t("session.compose.filesDisabled")}
                disabled={sending}
                onClick={() => {
                  if (!filesEnabled) return setSendError(t("session.compose.filesDisabledHint"));
                  setSendError(null);
                  fileInputRef.current?.click();
                }}
                className="mb-0.5 flex-none rounded-lg p-2 text-bone-faint transition-colors hover:bg-iron-800 hover:text-fel-bright disabled:opacity-30"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 1 1-2.83-2.83l8.49-8.48" />
                </svg>
              </button>
              <textarea
                ref={textareaRef}
                className="max-h-48 min-h-[2.4rem] flex-1 resize-none bg-transparent px-1.5 py-2 font-mono text-sm leading-relaxed text-bone placeholder:text-bone-faint focus:outline-none"
                rows={1}
                value={input}
                placeholder={t("session.compose.placeholder")}
                disabled={sending}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 192)}px`;
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
                onPaste={(e) => {
                  const dt = e.clipboardData;
                  const pasted: File[] = [];
                  if (dt.files.length) pasted.push(...Array.from(dt.files));
                  else for (const it of Array.from(dt.items)) if (it.kind === "file") { const f = it.getAsFile(); if (f) pasted.push(f); }
                  if (!pasted.length) return; // plain text → paste normally
                  e.preventDefault();
                  // Screenshots arrive as generic "image.png" — give them unique names so multiple don't collide on upload.
                  addFiles(pasted.map((f, i) => (f.name && f.name !== "image.png" ? f : new File([f], `pasted-${Date.now()}-${i}.${(f.type.split("/")[1] || "bin").replace("jpeg", "jpg")}`, { type: f.type }))));
                }}
              />
              <button
                type="button"
                onClick={send}
                disabled={sending || (!input.trim() && files.length === 0)}
                title={t("session.compose.send")}
                className="mb-0.5 flex-none rounded-lg bg-fel p-2 text-fel-ink transition-colors hover:bg-fel-bright disabled:bg-iron-800 disabled:text-bone-faint"
              >
                {sending ? (
                  <span className="block h-[18px] w-[18px] animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                )}
              </button>
            </div>
          </div>
        </div>
        </div>,
        document.body,
      )}
      {preview &&
        createPortal(
          <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/85 p-8" onClick={() => setPreview(null)}>
            <img src={preview} alt="" className="max-h-[90vh] max-w-[90vw] rounded-lg" />
          </div>,
          document.body,
        )}
    </div>
  );
}
