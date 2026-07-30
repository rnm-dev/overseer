const SENSITIVE_KEY = /(authorization|cookie|token|secret|credential|pairing|prompt|transcript|body|path|email)/i;
const TOKEN_VALUE = /\b(?:bearer\s+\S+|pn_[A-Za-z0-9._~-]+|sk-[A-Za-z0-9_-]+)\b/gi;
const ABSOLUTE_PATH = /(?:^|\s)(?:\/(?:Users|home|root|tmp|var|opt|rnm)\/[^\s,;]+|[A-Za-z]:\\[^\s,;]+)/g;

function truncate(value, maxLength) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 14))}…[truncated]`;
}

function redactString(value, maxLength) {
  return truncate(
    value
      .replace(TOKEN_VALUE, "[REDACTED]")
      .replace(ABSOLUTE_PATH, (match) => `${match.startsWith(" ") ? " " : ""}[REDACTED_PATH]`),
    maxLength,
  );
}

export function redactDiagnostic(value, options = {}, seen = new WeakSet()) {
  const maxValueLength = options.maxValueLength ?? 512;
  if (typeof value === "string") return redactString(value, maxValueLength);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.slice(0, options.maxArrayItems ?? 32)
      .map((item) => redactDiagnostic(item, options, seen));
  }

  const result = {};
  const entries = Object.entries(value).slice(0, options.maxObjectKeys ?? 64);
  for (const [key, nested] of entries) {
    result[key] = SENSITIVE_KEY.test(key)
      ? "[REDACTED]"
      : redactDiagnostic(nested, options, seen);
  }
  return result;
}

export class BoundedDiagnostics {
  constructor(options = {}) {
    this.maxEntries = options.maxEntries ?? 128;
    this.maxBytes = options.maxBytes ?? 64 * 1024;
    this.maxValueLength = options.maxValueLength ?? 512;
    this.clock = options.clock ?? Date.now;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 0) {
      throw new Error("maxEntries must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes <= 0) {
      throw new Error("maxBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxValueLength) || this.maxValueLength <= 0) {
      throw new Error("maxValueLength must be a positive safe integer");
    }
    if (typeof this.clock !== "function") throw new Error("clock must be a function");
    this.entries = [];
    this.bytes = 0;
    this.droppedEntries = 0;
  }

  add(event, details = {}) {
    const entry = redactDiagnostic({
      at: this.clock(),
      event: truncate(String(event), 96),
      details,
    }, { maxValueLength: this.maxValueLength });
    let serialized = JSON.stringify(entry);
    let bytes = Buffer.byteLength(serialized, "utf8");

    if (bytes > this.maxBytes) {
      const replacement = {
        at: entry.at,
        event: entry.event,
        details: { diagnostic: "[ENTRY_EXCEEDED_BOUND]" },
      };
      serialized = JSON.stringify(replacement);
      bytes = Buffer.byteLength(serialized, "utf8");
      this.droppedEntries += 1;
      this.#push(replacement, bytes);
      return;
    }
    this.#push(entry, bytes);
  }

  #push(entry, bytes) {
    while (this.entries.length >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.bytes -= removed.bytes;
      this.droppedEntries += 1;
    }
    if (bytes > this.maxBytes || this.maxEntries === 0) {
      this.droppedEntries += 1;
      return;
    }
    this.entries.push({ value: entry, bytes });
    this.bytes += bytes;
  }

  artifact() {
    return {
      formatVersion: 1,
      bounds: { maxEntries: this.maxEntries, maxBytes: this.maxBytes },
      droppedEntries: this.droppedEntries,
      bytes: this.bytes,
      entries: this.entries.map((entry) => entry.value),
    };
  }
}
