import os from "node:os";
import path from "node:path";

const APP_NAME = ".peon";

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, APP_NAME);
}

export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, APP_NAME);
}

export function dataDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, APP_NAME);
}
