import { realpathSync, statSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";

export type DirectoryWatchEvent = "changed" | "failed";
interface Entry {
  watcher: FSWatcher;
  listeners: Set<(event: DirectoryWatchEvent) => void>;
  timer?: ReturnType<typeof setTimeout>;
}

// Native watches are shared even when different Overseer connections watch the
// same directory. No recursive project scan, filenames or file bodies here.
export class DirectoryWatchRegistry {
  private entries = new Map<string, Entry>();
  get size(): number { return this.entries.size; }

  subscribe(directory: string, listener: (event: DirectoryWatchEvent) => void): () => void {
    const stat = statSync(directory);
    const identity = JSON.stringify([directory, stat.dev, stat.ino]);
    let entry = this.entries.get(identity);
    if (!entry) {
      if (this.entries.size >= 1024) throw new Error("watch limit");
      const watcher = watch(directory, { persistent: false });
      entry = { watcher, listeners: new Set() };
      const current = entry;
      this.entries.set(identity, current);
      watcher.on("change", () => {
        if (current.timer) return;
        current.timer = setTimeout(() => {
          current.timer = undefined;
          for (const callback of [...current.listeners]) callback("changed");
        }, 150);
      });
      watcher.on("error", () => {
        this.close(identity, current);
        for (const callback of [...current.listeners]) callback("failed");
        current.listeners.clear();
      });
    }
    const current = entry;
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
      if (!current.listeners.size) this.close(identity, current);
    };
  }

  private close(directory: string, entry: Entry): void {
    clearTimeout(entry.timer);
    entry.watcher.close();
    if (this.entries.get(directory) === entry) this.entries.delete(directory);
  }
}

// Pin both root and target: fs.watch follows an inode and can otherwise keep
// silently watching a renamed directory, or one moved outside the project.
export function directoryWatchTarget(root: string, relative: string) {
  if (relative.length > 4096 || relative.includes("\\") || /[\0-\x1f\x7f]/.test(relative)
    || path.isAbsolute(relative) || path.win32.isAbsolute(relative)
    || (relative !== "" && relative.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new Error("invalid directory");
  }
  const rootReal = realpathSync(root);
  const lexical = path.resolve(rootReal, relative);
  const directory = realpathSync(lexical);
  const rel = path.relative(rootReal, directory);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("path escape");
  const rootStat = statSync(rootReal);
  const targetStat = statSync(directory);
  if (!rootStat.isDirectory() || !targetStat.isDirectory()) throw new Error("not a directory");
  return {
    directory,
    valid: () => {
      try {
        const nextRoot = statSync(root);
        const next = statSync(lexical);
        return realpathSync(root) === rootReal && realpathSync(lexical) === directory
          && nextRoot.dev === rootStat.dev && nextRoot.ino === rootStat.ino
          && next.dev === targetStat.dev && next.ino === targetStat.ino;
      } catch { return false; }
    },
  };
}
