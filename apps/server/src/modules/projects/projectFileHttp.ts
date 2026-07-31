// `directory=1` is an Overseer-private UI hint. Remove only parameters whose
// decoded name is exactly `directory`, preserving all other raw query details
// for the single authenticated Fleet HTTP request.
export function projectFileProxyQuery(originalUrl: string): string {
  const marker = originalUrl.indexOf("?");
  if (marker < 0) return "";
  const raw = originalUrl.slice(marker + 1);
  const kept = raw.split("&").filter((part) => {
    const equals = part.indexOf("=");
    const rawName = part.slice(0, equals < 0 ? part.length : equals);
    try {
      return decodeURIComponent(rawName.replace(/\+/g, " ")) !== "directory";
    } catch {
      return true;
    }
  });
  return kept.length && kept.some((part) => part.length > 0) ? `?${kept.join("&")}` : "";
}
