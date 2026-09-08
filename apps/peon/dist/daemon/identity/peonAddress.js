import os from "node:os";
import { settings } from "../settings/index.js";
import { parseListenAddress } from "../../shared/listenAddress.js";
function directControlUrl() {
    const hostname = os.hostname();
    const host = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
    const port = parseListenAddress(settings.get().listenAddress).port;
    return `http://${host}:${port}`;
}
const LOCAL_ONLY_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0", "::"]);
/**
 * The canonical address an overseer should use when calling this peon back.
 *
 * publicControlUrl is operator-owned: it may be a Tailscale MagicDNS name or the
 * external side of a reverse proxy, neither of which can be reconstructed from the
 * source IP of a registration request. Keep a defensive fallback for old or
 * manually-edited settings files, but never replace a valid configured domain
 * with os.hostname() or a socket address.
 */
export function peonPublicUrl() {
    const configured = settings.get().publicControlUrl.trim();
    try {
        const url = new URL(configured);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
            return directControlUrl();
        }
        if (LOCAL_ONLY_HOSTS.has(url.hostname.replace(/^\[|\]$/g, "")))
            return directControlUrl();
        url.hash = "";
        url.search = "";
        return url.toString().replace(/\/$/, "");
    }
    catch {
        return directControlUrl();
    }
}
