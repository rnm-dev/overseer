// Provider timestamps are provenance, not Peon's canonical event clock. Keep
// only RFC 3339-like strings that represent a real instant; adapters can then
// copy this metadata without exposing each provider's native field names.
const RFC3339_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
function isValidRfc3339(value) {
    const match = RFC3339_TIMESTAMP.exec(value);
    if (!match)
        return false;
    const [, yearText, monthText, dayText, hourText, minuteText, secondText, offsetHourText, offsetMinuteText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12
        && day >= 1 && day <= daysInMonth[month - 1]
        && Number(hourText) <= 23
        && Number(minuteText) <= 59
        && Number(secondText) <= 59
        && (offsetHourText === undefined || Number(offsetHourText) <= 23)
        && (offsetMinuteText === undefined || Number(offsetMinuteText) <= 59)
        && Number.isFinite(Date.parse(value));
}
export function sourceTimestampMetadata(raw) {
    const value = raw.timestamp;
    if (typeof value !== "string" || !isValidRfc3339(value))
        return {};
    return { sourceTimestamp: value };
}
export function storedTimestampMetadata(raw) {
    const metadata = {};
    if (typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) && raw.createdAt >= 0) {
        metadata.createdAt = raw.createdAt;
    }
    const source = typeof raw.sourceTimestamp === "string"
        ? sourceTimestampMetadata({ timestamp: raw.sourceTimestamp })
        : sourceTimestampMetadata(raw); // compatibility with old raw Claude rows
    return { ...metadata, ...source };
}
