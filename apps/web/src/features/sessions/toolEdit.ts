// Pure parsers for edit-tool inputs: operation, file name, diff lines and
// added/removed counts. Rendering lives in ./messageParts.

export type DiffLine = {
  kind: "context" | "remove" | "add";
  text: string;
  oldLine?: number;
  newLine?: number;
};

export function editStats(lines: DiffLine[] | null): { added: number; removed: number } | null {
  if (!lines) return null;
  return lines.reduce((counts, line) => {
    if (line.kind === "add") counts.added++;
    if (line.kind === "remove") counts.removed++;
    return counts;
  }, { added: 0, removed: 0 });
}

export type EditOperation = "Create" | "Delete" | "Edit";

function normalizedChangeKind(change: Record<string, unknown>): string | null {
  const rawKind = change.kind;
  if (typeof rawKind === "string") return rawKind.trim().toLowerCase();
  if (rawKind && typeof rawKind === "object") {
    const type = (rawKind as Record<string, unknown>).type;
    if (typeof type === "string") return type.trim().toLowerCase();
  }
  return null;
}

function operationFromKind(kind: string | null): EditOperation | null {
  if (kind === "add" || kind === "create" || kind === "added") return "Create";
  if (kind === "delete" || kind === "remove" || kind === "deleted") return "Delete";
  if (kind === "update" || kind === "edit" || kind === "rename") return "Edit";
  return null;
}

export function editOperation(input: unknown): EditOperation {
  if (!input || typeof input !== "object") return "Edit";
  const value = input as Record<string, unknown>;
  if (Array.isArray(value.changes) && value.changes.length > 0) {
    const operations = value.changes.map((rawChange) => {
      if (!rawChange || typeof rawChange !== "object") return null;
      return operationFromKind(normalizedChangeKind(rawChange as Record<string, unknown>));
    });
    if (operations.every((operation) => operation === "Create")) return "Create";
    if (operations.every((operation) => operation === "Delete")) return "Delete";
    if (operations.some(Boolean)) return "Edit";
  }

  const patch = value.patch ?? value.diff;
  if (typeof patch === "string") {
    if (/^\*\*\* Add File:/m.test(patch) || /^---\s+\/dev\/null\s*$/m.test(patch)) return "Create";
    if (/^\*\*\* Delete File:/m.test(patch) || /^\+\+\+\s+\/dev\/null\s*$/m.test(patch)) return "Delete";
  }
  return "Edit";
}

function statsFromDiff(diff: string, operation: EditOperation): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const hunks: Array<{ oldLength: number; newLength: number }> = [];
  const lines = diff.split("\n");
  for (const line of lines) {
    const hunk = /^@@ -(?:\d+)(?:,(\d+))? \+(?:\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      hunks.push({ oldLength: hunk[1] === undefined ? 1 : Number(hunk[1]), newLength: hunk[2] === undefined ? 1 : Number(hunk[2]) });
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) added++;
    if (line.startsWith("-") && !line.startsWith("---")) removed++;
  }
  const patchLike = hunks.length > 0
    || lines.some((line) => /^\*\*\* (?:Add|Delete|Update) File:/.test(line))
    || (lines.some((line) => /^--- (?:\/dev\/null|[ab]\/)/.test(line)) && lines.some((line) => /^\+\+\+ (?:\/dev\/null|[ab]\/)/.test(line)));

  // Current Codex app-server sends a new/deleted file's complete contents in
  // `diff`, without unified-diff prefixes. Older builds sent a patch instead.
  // Patch markers mean the latter; otherwise count raw contents directly.
  if (operation === "Create" && !patchLike) return { added: contentLineCount(diff), removed: 0 };
  if (operation === "Delete" && !patchLike) return { added: 0, removed: contentLineCount(diff) };

  // Some builds emit only hunk metadata for whole-file creates/deletes. Those
  // ranges are exact because the opposite side is empty.
  if (operation === "Create" && added === 0) {
    added = hunks.reduce((count, hunk) => count + (hunk.oldLength === 0 ? hunk.newLength : 0), 0);
  }
  if (operation === "Delete" && removed === 0) {
    removed = hunks.reduce((count, hunk) => count + (hunk.newLength === 0 ? hunk.oldLength : 0), 0);
  }
  return { added, removed };
}

function contentLineCount(content: string): number {
  if (content === "") return 0;
  const lines = content.split("\n");
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

export function editStatsFromInput(input: unknown): { added: number; removed: number } | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const operation = editOperation(input);
  if (Array.isArray(value.changes)) {
    let added = 0;
    let removed = 0;
    let foundDiff = false;
    for (const rawChange of value.changes) {
      if (!rawChange || typeof rawChange !== "object") continue;
      const diff = (rawChange as Record<string, unknown>).diff;
      if (typeof diff !== "string") continue;
      foundDiff = true;
      const stats = statsFromDiff(diff, operation);
      added += stats.added;
      removed += stats.removed;
    }
    if (foundDiff) return { added, removed };
  }
  const oldText = value.old_string;
  const newText = value.new_string;
  if (typeof oldText === "string" && typeof newText === "string") {
    return {
      added: newText === "" ? 0 : newText.split("\n").length,
      removed: oldText === "" ? 0 : oldText.split("\n").length,
    };
  }
  return null;
}

export function editFileName(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  const explicitPath = value.file_path ?? value.filePath ?? value.notebook_path ?? value.notebookPath ?? value.path ?? value.filename;
  let path = typeof explicitPath === "string" && explicitPath.trim() ? explicitPath.trim() : null;
  let additionalFiles = 0;

  if (!path && Array.isArray(value.changes)) {
    const paths = value.changes
      .map((change) => change && typeof change === "object" ? (change as Record<string, unknown>).path : undefined)
      .filter((candidate): candidate is string => typeof candidate === "string" && !!candidate.trim());
    path = paths[0]?.trim() ?? null;
    additionalFiles = Math.max(0, paths.length - 1);
  }

  if (!path) {
    const patch = value.patch ?? value.diff;
    if (typeof patch === "string") {
      path = patch.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m)?.[1]?.trim()
        ?? patch.match(/^\+\+\+\s+(?:b\/)?(.+)$/m)?.[1]?.trim()
        ?? null;
    }
  }

  if (!path) return null;
  const fileName = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return additionalFiles > 0 ? `${fileName} (+${additionalFiles})` : fileName;
}

export function editDiff(input: unknown): DiffLine[] | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;

  // Codex emits exact per-invocation unified diffs on each changed file.
  if (Array.isArray(value.changes)) {
    const lines: DiffLine[] = [];
    for (const rawChange of value.changes) {
      if (!rawChange || typeof rawChange !== "object") continue;
      const change = rawChange as Record<string, unknown>;
      const path = typeof change.path === "string" ? change.path : "changed file";
      if (typeof change.diff === "string") {
        let oldLine: number | undefined;
        let newLine: number | undefined;
        for (const text of change.diff.split("\n")) {
          const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
          if (hunk) {
            oldLine = Number(hunk[1]);
            newLine = Number(hunk[2]);
            lines.push({ kind: "context", text });
            continue;
          }
          const isHeader = text.startsWith("+++") || text.startsWith("---");
          const kind: DiffLine["kind"] = !isHeader && text.startsWith("+") ? "add" : !isHeader && text.startsWith("-") ? "remove" : "context";
          const numbered = oldLine !== undefined && newLine !== undefined && !isHeader;
          lines.push({
            kind,
            text: kind === "context" ? text : text.slice(1),
            oldLine: numbered && kind !== "add" ? oldLine : undefined,
            newLine: numbered && kind !== "remove" ? newLine : undefined,
          });
          if (numbered && kind !== "add") oldLine = oldLine! + 1;
          if (numbered && kind !== "remove") newLine = newLine! + 1;
        }
      }
      if (change.diffTruncated === true) {
        const originalBytes = typeof change.diffOriginalBytes === "number" ? ` (${change.diffOriginalBytes.toLocaleString()} bytes originally)` : "";
        lines.push({ kind: "context", text: `… diff truncated for ${path}${originalBytes}` });
      }
      if (typeof change.diffUnavailable === "string") {
        lines.push({ kind: "context", text: `Diff unavailable for ${path}: ${change.diffUnavailable}` });
      }
    }
    if (lines.length) return lines;
  }

  const { old_string: oldText, new_string: newText } = value;
  if (typeof oldText !== "string" || typeof newText !== "string") return null;

  const before = oldText.split("\n");
  const after = newText.split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () => new Uint32Array(after.length + 1));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i]![j] = before[i] === after[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      lines.push({ kind: "context", text: before[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (j < after.length && (i === before.length || lengths[i]![j + 1]! >= lengths[i + 1]![j]!)) {
      lines.push({ kind: "add", text: after[j]!, newLine: j + 1 });
      j++;
    } else {
      lines.push({ kind: "remove", text: before[i]!, oldLine: i + 1 });
      i++;
    }
  }
  return lines;
}
