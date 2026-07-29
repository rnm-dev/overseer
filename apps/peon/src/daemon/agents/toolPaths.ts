import path from "node:path";

export function projectRelativePath(value: unknown, cwd?: string): unknown {
  if (typeof value !== "string" || !cwd || !path.isAbsolute(value)) return value;
  const relative = path.relative(path.resolve(cwd), path.resolve(value));
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    ? relative
    : value;
}

export function normalizeFileToolInput(name: unknown, rawInput: unknown, cwd?: string): unknown {
  if (!["Read", "Write", "Edit"].includes(String(name)) || !rawInput || typeof rawInput !== "object") return rawInput;
  const input = rawInput as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...input };
  for (const field of ["file_path", "filePath", "path"] as const) {
    if (Object.hasOwn(input, field)) normalized[field] = projectRelativePath(input[field], cwd);
  }
  if (Array.isArray(input.changes)) {
    normalized.changes = input.changes.map((raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const change = raw as Record<string, unknown>;
      return {
        ...change,
        ...(Object.hasOwn(change, "path") ? { path: projectRelativePath(change.path, cwd) } : {}),
        ...(Object.hasOwn(change, "oldPath") ? { oldPath: projectRelativePath(change.oldPath, cwd) } : {}),
      };
    });
  }
  return normalized;
}
