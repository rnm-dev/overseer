const REDACTED = "[REDACTED]";
export function createArmoryRedactor(sensitiveValues) {
    const secrets = [...new Set([...sensitiveValues].filter((value) => value.length > 0))].sort((a, b) => b.length - a.length);
    const text = (value) => secrets.reduce((current, secret) => current.split(secret).join(REDACTED), value);
    const redact = (value, seen) => {
        if (typeof value === "string")
            return text(value);
        if (!value || typeof value !== "object")
            return value;
        if (seen.has(value))
            return REDACTED;
        seen.add(value);
        if (Array.isArray(value))
            return value.map((entry) => redact(entry, seen));
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(entry, seen)]));
    };
    return { text, value: (value) => redact(value, new WeakSet()) };
}
