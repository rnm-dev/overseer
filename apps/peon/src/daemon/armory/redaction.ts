const REDACTED = "[REDACTED]";

export interface ArmoryRedactor {
  text(value: string): string;
  value<T>(value: T): T;
}

export function createArmoryRedactor(sensitiveValues: Iterable<string>): ArmoryRedactor {
  const secrets = [...new Set([...sensitiveValues].filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
  const text = (value: string): string => secrets.reduce((current, secret) => current.split(secret).join(REDACTED), value);
  const redact = (value: unknown, seen: WeakSet<object>): unknown => {
    if (typeof value === "string") return text(value);
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return REDACTED;
    seen.add(value);
    if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, seen)]));
  };
  return { text, value: <T>(value: T): T => redact(value, new WeakSet()) as T };
}
