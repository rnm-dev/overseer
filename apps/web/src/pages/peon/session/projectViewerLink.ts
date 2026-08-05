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

function decodedPath(href: string, currentOrigin?: string): { path: string; suffix: string } | null {
  if (/^https?:\/\//i.test(href)) {
    try {
      const url = new URL(href);
      if (!currentOrigin || url.origin !== currentOrigin) return null;
      return { path: decodeURIComponent(url.pathname), suffix: `${url.search}${url.hash}` };
    } catch {
      return null;
    }
  }
  if (href.startsWith("file://")) {
    try {
      const url = new URL(href);
      return { path: decodeURIComponent(url.pathname), suffix: `${url.search}${url.hash}` };
    } catch {
      return null;
    }
  }
  const split = splitSuffix(href);
  const absoluteWindows = /^[a-zA-Z]:[\\/]/.test(split.path);
  if (!absoluteWindows && (!split.path.startsWith("/") || split.path.startsWith("//"))) return null;
  try {
    return { path: decodeURIComponent(split.path), suffix: split.suffix };
  } catch {
    return null;
  }
}

export function projectViewerHref(href: string, context: ProjectViewerContext): string | null {
  const decoded = decodedPath(href, context.currentOrigin);
  if (!decoded) return null;
  const root = context.projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  // Agents cite files as /path/file.ts:312 or :312:4; the position is not part
  // of the name on disk, and keeping it makes the Peon answer 404.
  const candidate = decoded.path.replace(/\\/g, "/").replace(/:\d+(?::\d+)?$/, "");
  if (!root || candidate === root || !candidate.startsWith(`${root}/`)) return null;
  const relative = candidate.slice(root.length + 1);
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
