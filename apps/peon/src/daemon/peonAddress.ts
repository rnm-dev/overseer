import os from "node:os";
import { settings } from "./settings/index.js";

const CONTROL_PORT = Number(process.env.ACA_CONTROL_PORT ?? 4570);

function directControlUrl(): string {
  const hostname = os.hostname();
  const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return `http://${host}:${CONTROL_PORT}`;
}

/**
 * The canonical address an overseer should use when calling this peon back.
 *
 * publicControlUrl is operator-owned: it may be a mesh DNS name or the public
 * side of a reverse proxy, neither of which can be reconstructed from the
 * source IP of a registration request. Keep a defensive fallback for old or
 * manually-edited settings files, but never replace a valid configured domain
 * with os.hostname() or a socket address.
 */
export function peonPublicUrl(): string {
  const configured = settings.get().publicControlUrl.trim();
  try {
    const url = new URL(configured);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return directControlUrl();
    }
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return directControlUrl();
  }
}
