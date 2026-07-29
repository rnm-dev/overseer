(function () {
  function coerceValue(raw) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    if (raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
    return raw;
  }

  function timeAgo(ts) {
    if (!ts) return null;
    const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    return `${Math.floor(min / 60)}h ago`;
  }

  const PRIORITY_TONE = { urgent: "red", high: "amber", medium: "slate", low: "slate", none: "slate" };

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatTokens(n) {
    if (n == null) return "—";
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(2)}M`;
  }

  // Sub-dollar amounts keep 4dp precision, matching the per-session usage
  // widget's existing $0.0042-style display; larger totals round to cents.
  function formatCost(n) {
    if (n == null) return "—";
    return `$${n.toFixed(n < 1 ? 4 : 2)}`;
  }

  function formatDuration(ms) {
    if (ms == null) return "—";
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    const pad = (v) => String(v).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // Preview paths are transport details. Show project files relative to the
  // session cwd and reduce anything external/temp to its filename so private
  // machine paths never leak into the visible UI or hover text.
  function previewDisplayPath(filePath, sessionDir) {
    if (!filePath) return "Preview";
    const normalized = String(filePath).replaceAll("\\", "/");
    const base = sessionDir ? String(sessionDir).replaceAll("\\", "/").replace(/\/$/, "") : "";
    if (base && normalized.startsWith(`${base}/`)) return normalized.slice(base.length + 1);
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) {
      return normalized.split("/").filter(Boolean).pop() || "Preview";
    }
    return normalized;
  }

  Object.assign(window.ACA, { coerceValue, timeAgo, PRIORITY_TONE, formatBytes, formatTokens, formatCost, formatDuration, previewDisplayPath });
})();
