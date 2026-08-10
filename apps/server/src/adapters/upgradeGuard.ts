import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

// Node hands a protocol upgrade to whatever listeners the application
// registered and then stops caring about the socket: as soon as one 'upgrade'
// listener exists, an upgrade nobody handled is nobody's, and the socket
// survives the client's FIN as a CLOSE_WAIT file descriptor for the whole life
// of the process. A retired endpoint an old client still dials therefore leaks
// a descriptor per attempt.
//
// So every upgrade handler claims the requests it owns *synchronously* — before
// any await — and the fallback registered after all of them refuses the rest.
const claimed = new WeakSet<IncomingMessage>();

export function claimUpgrade(req: IncomingMessage): void {
  claimed.add(req);
}

export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

// A claimed upgrade still has to finish. Authentication reaches the database, so
// a claim is not a promise that the handshake will ever complete — this bounds
// the wait rather than trusting it.
export function armUpgradeTimeout(socket: Duplex, timeoutMs: number): () => void {
  const timer = setTimeout(() => refuseUpgrade(socket, 504, "Gateway Timeout"), timeoutMs);
  timer.unref();
  return () => clearTimeout(timer);
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? "", "http://overseer.local").pathname;
  } catch {
    return "/";
  }
}

export interface UpgradeFallbackOptions {
  // Names the caller behind a refused upgrade — an outdated Peon dialling a
  // retired endpoint is otherwise anonymous, because every peer address at the
  // edge belongs to the proxy. Must never return the credential itself.
  identify?: (req: IncomingMessage) => Promise<string | null>;
  log?: (message: string) => void;
  reportIntervalMs?: number;
}

// Register AFTER every real upgrade handler: listeners run in registration
// order, and this one refuses whatever none of them claimed.
export function attachUpgradeFallback(server: Server, options: UpgradeFallbackOptions = {}): void {
  const log = options.log ?? ((message: string) => console.warn(message));
  const interval = options.reportIntervalMs ?? 60_000;
  // One line per path per interval: a client that retries every 40s should not
  // be able to write the log full of its own disappointment.
  const reportedAt = new Map<string, number>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    if (claimed.has(req)) return;
    const path = pathOf(req);
    refuseUpgrade(socket, 400, "Bad Request");

    const last = reportedAt.get(path) ?? 0;
    const now = Date.now();
    if (now - last < interval) return;
    if (reportedAt.size > 100) reportedAt.clear();
    reportedAt.set(path, now);
    void (async () => {
      const who = options.identify ? await options.identify(req).catch(() => null) : null;
      log(`overseer: refused websocket upgrade to ${path}${who ? ` from ${who}` : ""}`);
    })();
  });
}
