// How an agent's link names a file. Agents write files every way a person
// would — /abs/path.ts:12, file:///C:/work/a.html, docs/spec.md, report.md:12 —
// and a renderer that cannot tell one of those from a web address either opens
// it in a new tab, where it resolves against the chat's own route, or lets the
// Markdown sanitizer empty it, and an empty href in a new tab is the chat again.

// A scheme-less path that is really a web address: example.com/pricing. Agents
// write bare domains often enough that resolving them as files would turn
// ordinary links into missing files.
const BARE_HOST = /^[^/]+\.(?:com|org|net|io|dev|app|ai|co|me|sh|ru|kz)$/i;

// A source position written straight after a name. report.md:12 reads to a URL
// parser as the scheme `report.md`; the extension is what says it is a file, and
// requiring one keeps javascript:1 a scheme.
const NAME_POSITION = /(\.[a-zA-Z0-9_-]+):\d+(?::\d+)?$/;

const SOURCE_POSITION = /:\d+(?::\d+)?$/;

export function localFilePath(href: string | undefined): string | null {
  if (!href) return null;
  let path = href;
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the original path when it contains a malformed escape sequence.
  }
  if (path.startsWith("file://")) {
    try {
      // A URL pathname always opens with a slash, which is part of a POSIX
      // path and never part of a Windows one: file:///C:/work/a.html reads
      // back as /C:/work/a.html, and a Peon asked for that answers NOT_FOUND.
      // Decoded after parsing, not before: `new URL` re-encodes the space in
      // a name the first decode had already opened up, and the Peon is then
      // asked for a file called `a%20file.html`.
      path = decodeURIComponent(new URL(path).pathname).replace(/^\/(?=[a-zA-Z]:[\\/])/, "");
    } catch {
      return null;
    }
  }
  if (!(path.startsWith("/") && !path.startsWith("//")) && !/^[a-zA-Z]:[\\/]/.test(path)) return null;
  // Codex file links can carry a source position as /path/file.ts:12:4 or #L12.
  return path.replace(/#L\d+(?:-L?\d+)?$/, "").replace(SOURCE_POSITION, "");
}

// Whether a scheme-less, rootless path names a file: docs/spec.md, report.md:12.
// Fragments, queries and web addresses are not files.
export function isRelativeFilePath(path: string): boolean {
  if (!path || /^[/#?]/.test(path)) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path.replace(NAME_POSITION, "$1"))) return false;
  const segments = path.replace(/^\.\//, "").split("/");
  return segments.length > 1 ? !BARE_HOST.test(segments[0]!) : true;
}

// The file a relative link names, without its query, fragment or position. The
// session file route resolves it against the session's working directory.
export function relativeFilePath(href: string | undefined): string | null {
  if (!href) return null;
  const path = href.split(/[?#]/, 1)[0]!;
  if (!isRelativeFilePath(path)) return null;
  let decoded = path;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    // Keep the original path when it contains a malformed escape sequence.
  }
  const relative = decoded.replace(/^\.\//, "").replace(SOURCE_POSITION, "");
  const segments = relative.split("/");
  return segments.some((segment) => !segment || segment === "." || segment === "..") ? null : relative;
}
