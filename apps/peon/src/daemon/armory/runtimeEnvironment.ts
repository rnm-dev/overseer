import path from "node:path";

const SYSTEM_COMMAND_DIRS = ["/usr/local/bin", "/usr/bin", "/bin"];

/**
 * A deterministic command search path for trusted Armory packages.
 *
 * Do not inherit the daemon's PATH: it may contain operator-specific entries or
 * secrets. The Node directory keeps manifest `node` commands working while the
 * fixed system directories support host executables whose wrappers invoke
 * standard utilities.
 */
export const ARMORY_COMMAND_PATH = [
  path.dirname(process.execPath),
  ...SYSTEM_COMMAND_DIRS,
].filter((entry, index, entries) => entries.indexOf(entry) === index).join(path.delimiter);
