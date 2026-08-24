// The demo Peon's answer for `GET /projects/:key/files/*`.
//
// Kept out of runScreenshotDemoPeon.ts, which starts listening at import, so
// this half can be exercised by a test without binding a port.
//
// It mirrors the real Peon (apps/peon/src/daemon/agentApi.ts): `?stat` is the
// metadata request and it is polymorphic — a directory answers with its
// listing, a file with its size and digest — while a request with no `stat` is
// a download and answers with bytes.
//
// This is the contract Overseer actually proxies, and getting it wrong is
// invisible until the Files tab is opened: `projectFileProxyQuery` strips the
// Overseer-private `directory` hint, so a demo Peon that keyed its listing off
// `directory=1` was asked for a listing it never recognised, answered with a
// file body, and left the client parsing a string where it wanted entries — a
// bare "Retry".

/** A file's own metadata, or a directory's listing — what `?stat` answers. */
export type DemoFileStat =
  | { path: string; type: "directory"; entries: DemoDirectoryEntry[] }
  | { path: string; type: "file"; size: number; mtimeMs: number; sha256: string };

export interface DemoDirectoryEntry {
  name: string;
  type: "directory" | "file";
  size?: number;
  mtimeMs?: number;
}

export type DemoFileResponse =
  | { kind: "stat"; body: DemoFileStat }
  | { kind: "content"; body: string; contentType: string };

const DEMO_MARKDOWN =
  "# Mobile App\n\nA polished companion for coordinating AI-assisted work.\n\n## Current focus\n\n- Faster onboarding\n- Accessible navigation\n- Reliable offline workflows\n- App Store launch readiness\n";

// The fictional tree the screenshots walk. Only directories need naming: in a
// demo every other path is a file, and answering with the same curated document
// is the point rather than a shortcut.
const DIRECTORIES: Record<string, DemoDirectoryEntry[]> = {
  "": [
    { name: "docs", type: "directory" },
    { name: "lib", type: "directory" },
    { name: "README.md", type: "file", size: 1240 },
    { name: "pubspec.yaml", type: "file", size: 860 },
  ],
  docs: [
    { name: "onboarding.md", type: "file", size: 2140 },
    { name: "release-checklist.md", type: "file", size: 1180 },
  ],
  lib: [
    { name: "main.dart", type: "file", size: 640 },
    { name: "widgets", type: "directory" },
  ],
  "lib/widgets": [{ name: "session_card.dart", type: "file", size: 1520 }],
};

/** Trailing and leading slashes are not part of the identity of a path here. */
function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

export function isDemoDirectory(path: string): boolean {
  return normalize(path) in DIRECTORIES;
}

/**
 * What the demo Peon answers for one file path.
 *
 * `stat` is read as present-or-absent, not compared to "1", because that is how
 * the real Peon reads it — a client sending `stat=0` still means "describe it".
 */
export function demoFileResponse(path: string, stat: string | null): DemoFileResponse {
  const normalized = normalize(path);
  const entries = DIRECTORIES[normalized];

  if (stat === null) {
    // A download. Directories have no bytes, and the real Peon refuses rather
    // than inventing some, but the demo is never asked to: the client stats a
    // path before it opens it.
    return { kind: "content", body: DEMO_MARKDOWN, contentType: "text/markdown; charset=utf-8" };
  }

  if (entries) return { kind: "stat", body: { path: normalized, type: "directory", entries } };
  return {
    kind: "stat",
    body: {
      path: normalized,
      type: "file",
      size: Buffer.byteLength(DEMO_MARKDOWN),
      mtimeMs: Date.now(),
      sha256: "0".repeat(64),
    },
  };
}
