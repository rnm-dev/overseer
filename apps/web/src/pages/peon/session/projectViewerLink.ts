export interface ProjectViewerContext {
  peonId: string;
  projectId: string;
  projectRoot: string;
  currentOrigin?: string;
}

function splitSuffix(value: string): { path: string; suffix: string } {
  const index = value.search(/[?#]/);
  return index < 0 ? { path: value, suffix: "" } : { path: value.slice(0, index), suffix: value.slice(index) };
}

// A scheme-less path that is really a web address: example.com/pricing. Agents
// write bare domains often enough that resolving them against the project root
// would turn ordinary links into missing files.
const BARE_HOST = /^[^/]+\.(?:com|org|net|io|dev|app|ai|co|me|sh|ru|kz)$/i;

function projectRelativeCandidate(path: string): boolean {
  if (!path || path.startsWith("/")) return false;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false;
  const segments = path.replace(/^\.\//, "").split("/");
  return segments.length > 1 ? !BARE_HOST.test(segments[0]!) : true;
}

function decodedPath(href: string, currentOrigin?: string): { path: string; suffix: string; relative: boolean } | null {
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (!currentOrigin || url.origin !== currentOrigin) return null;
      return { path: decodeURIComponent(url.pathname), suffix: `${url.search}${url.hash}`, relative: false };
    } catch {
      return null;
    }
  }
  if (href.startsWith("file://")) {
    try {
      const url = new URL(href);
      return { path: decodeURIComponent(url.pathname), suffix: `${url.search}${url.hash}`, relative: false };
    } catch {
      return null;
    }
  }
  const split = splitSuffix(href);
  const absolute = /^[a-zA-Z]:[\\/]/.test(split.path) || (split.path.startsWith("/") && !split.path.startsWith("//"));
  if (!absolute && !projectRelativeCandidate(split.path)) return null;
  try {
    return { path: decodeURIComponent(split.path), suffix: split.suffix, relative: !absolute };
  } catch {
    return null;
  }
}

export function projectViewerHref(href: string, context: ProjectViewerContext): string | null {
  const decoded = decodedPath(href, context.currentOrigin);
  if (!decoded) return null;
  const root = context.projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!root) return null;
  // Agents cite files as /path/file.ts:312 or :312:4; the position is not part
  // of the name on disk, and keeping it makes the Peon answer 404.
  const candidate = decoded.path.replace(/\\/g, "/").replace(/:\d+(?::\d+)?$/, "");
  let relative: string;
  if (decoded.relative) {
    // Agents also write a file the way they name it in the project: docs/spec.md.
    // The project root is the only base such a path can mean; left alone, the
    // browser resolves it against the session route and lands nowhere.
    relative = candidate.replace(/^\.\//, "");
  } else {
    if (candidate === root || !candidate.startsWith(`${root}/`)) return null;
    relative = candidate.slice(root.length + 1);
  }
  const segments = relative.split("/");
  if (!segments.length || segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const encoded = segments.map(encodeURIComponent).join("/");
  return `/view/${encodeURIComponent(context.peonId)}/${encodeURIComponent(context.projectId)}/${encoded}${decoded.suffix}`;
}

export function projectViewerRelativePath(href: string, context: ProjectViewerContext): string | null {
  const pathOnly = splitSuffix(href).path;
  const prefix = `/view/${encodeURIComponent(context.peonId)}/${encodeURIComponent(context.projectId)}/`;
  if (!pathOnly.startsWith(prefix)) return null;
  const encoded = pathOnly.slice(prefix.length);
  if (!encoded) return null;
  try {
    const segments = encoded.split("/").map(decodeURIComponent);
    if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[\\/]/.test(segment))) return null;
    return segments.join("/");
  } catch {
    return null;
  }
}
