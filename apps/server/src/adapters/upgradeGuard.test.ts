import assert from "node:assert/strict";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import { test } from "node:test";
import { armUpgradeTimeout, attachUpgradeFallback, claimUpgrade } from "./upgradeGuard.js";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

// Speaks the upgrade request by hand: `ws` would reject the malformed handshake
// before we could observe whether the socket itself survives, and surviving is
// the whole subject here.
function upgrade(port: number, path: string, headers: string[] = []): Promise<{ response: string; closedByServer: boolean }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write([
        `GET ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        ...headers,
        "",
        "",
      ].join("\r\n"));
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", reject);
    // The server closing its end is the signal we care about; without the fix
    // this never fires and the timeout below is what fails the test.
    socket.on("close", () => resolve({ response, closedByServer: true }));
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ response, closedByServer: false });
    }, 2_000);
    socket.on("close", () => clearTimeout(timer));
  });
}

test("refuses and closes an upgrade no handler claimed", async () => {
  const server = http.createServer();
  // A retired endpoint's shape: a handler that only inspects the path.
  server.on("upgrade", (req) => { if (req.url === "/api/ws") claimUpgrade(req); });
  const logged: string[] = [];
  attachUpgradeFallback(server, { log: (message) => logged.push(message) });
  const port = await listen(server);

  const refused = await upgrade(port, "/api/v1/peons/transfer/ws");
  assert.equal(refused.closedByServer, true);
  assert.match(refused.response, /^HTTP\/1\.1 400 /);
  assert.deepEqual(logged, ["overseer: refused websocket upgrade to /api/v1/peons/transfer/ws"]);

  server.close();
});

test("leaves a claimed upgrade alone", async () => {
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    claimUpgrade(req);
    // Claimed but answered late — the fallback must not race the real handler,
    // whose credential lookup is asynchronous.
    setTimeout(() => socket.write("HTTP/1.1 101 Switching Protocols\r\n\r\n"), 50);
  });
  attachUpgradeFallback(server, { log: () => {} });
  const port = await listen(server);

  const accepted = await upgrade(port, "/api/v1/peons/ws");
  assert.equal(accepted.closedByServer, false);
  assert.match(accepted.response, /^HTTP\/1\.1 101 /);

  server.close();
});

test("reports a repeating caller once per interval, per path", async () => {
  const server = http.createServer();
  server.on("upgrade", () => {});
  const logged: string[] = [];
  attachUpgradeFallback(server, {
    log: (message) => logged.push(message),
    reportIntervalMs: 60_000,
    identify: async () => "peon \"Neo\" (peon-1)",
  });
  const port = await listen(server);

  await upgrade(port, "/gone");
  await upgrade(port, "/gone");
  await upgrade(port, "/also-gone");
  // identify() resolves after the socket is already destroyed.
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(logged, [
    "overseer: refused websocket upgrade to /gone from peon \"Neo\" (peon-1)",
    "overseer: refused websocket upgrade to /also-gone from peon \"Neo\" (peon-1)",
  ]);

  server.close();
});

test("closes a claimed upgrade whose handshake never completes", async () => {
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    claimUpgrade(req);
    armUpgradeTimeout(socket, 50);
  });
  attachUpgradeFallback(server, { log: () => {} });
  const port = await listen(server);

  const stalled = await upgrade(port, "/api/v1/peons/ws");
  assert.equal(stalled.closedByServer, true);
  assert.match(stalled.response, /^HTTP\/1\.1 504 /);

  server.close();
});
