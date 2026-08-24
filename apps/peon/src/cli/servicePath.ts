// The generated service units bake in the PATH `peon start` itself saw, so the
// daemon resolves `settings.agentCommand` the way a login shell would. That
// snapshot is only as good as the shell the operator happened to run the install
// from: a non-login shell, an SSH one-liner or a freshly-created account often
// lacks ~/.local/bin, which is where uv, pipx and a user-level npm prefix put
// their executables. Append it rather than prepend it — an operator who already
// has the directory on PATH keeps their own precedence untouched.

import os from "node:os";
import path from "node:path";

export function serviceEnvPath(
  currentPath: string | undefined,
  fallback: string,
  homeDir: string = os.homedir(),
): string {
  const entries = (currentPath?.trim() ? currentPath : fallback)
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
  const localBin = path.join(homeDir, ".local", "bin");
  if (!entries.includes(localBin)) entries.push(localBin);
  return entries.join(path.delimiter);
}
