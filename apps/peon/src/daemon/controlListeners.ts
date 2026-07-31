const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::"]);

export function isLoopbackBindHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * A concrete remote-interface bind does not also accept loopback traffic.
 * Peon's scoped MCP and local CLI endpoints intentionally require a genuine
 * loopback peer, so keep a private listener alongside the Fleet listener.
 */
export function controlListenerHosts(bindHost: string): string[] {
  if (LOOPBACK_HOSTS.has(bindHost) || WILDCARD_HOSTS.has(bindHost)) return [bindHost];
  return [bindHost, "127.0.0.1"];
}
