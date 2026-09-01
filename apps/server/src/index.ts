import { config, configErrors, configWarnings } from "./infrastructure/config/index.js";
import { initDb } from "./infrastructure/db/index.js";
import { createServer } from "./app/server.js";
import { startReconciler } from "./modules/sessions/index.js";
import { attachLiveSocket } from "./adapters/liveSocket.js";
import { attachPeonSocket } from "./adapters/peonSocket.js";
import { attachUpgradeFallback } from "./adapters/upgradeGuard.js";
import { describePeonUpgrade } from "./adapters/peonSocketAuth.js";
import { pruneEvents } from "./infrastructure/events/index.js";
import { startPushWorker } from "./modules/notifications/index.js";
import { configureEventDelivery } from "./app/eventDelivery.js";

async function main(): Promise<void> {
  // Before the database, so a misconfigured origin is named directly instead of
  // arriving as a connection failure or, worse, as a working boot on somebody
  // else's public URL.
  const errors = configErrors();
  if (errors.length > 0) {
    for (const e of errors) console.error(`overseer: ${e}`);
    process.exit(1);
  }
  await initDb();
  if (process.env.OVERSEER_APP_REVIEW_DEMO === "1") {
    await import("./cli/runScreenshotDemoPeon.js");
  }
  configureEventDelivery();
  const app = createServer();
  const server = app.listen(config.port, config.host, () => {
    console.log(`overseer: listening on http://${config.host}:${config.port}`);
    for (const w of configWarnings()) console.warn(`WARNING: ${w}`);
    // Rebuild/refresh the session index from every online peon, then keep it
    // fresh on an interval. The peon stays source of truth, so this reconciles
    // any drift a restart introduced.
    startReconciler();
    startPushWorker();
    // Keep the resumable event log bounded.
    setInterval(() => void pruneEvents().catch(() => null), 5 * 60_000);
  });
  // Resumable client transport shares the HTTP server (nginx upgrades /api/ws).
  attachLiveSocket(server);
  attachPeonSocket(server);
  // Last, deliberately: it refuses every upgrade the two handlers above did not
  // claim, so a retired endpoint an old daemon still dials cannot leak a socket.
  attachUpgradeFallback(server, { identify: describePeonUpgrade });
}

main().catch((err) => {
  console.error("overseer: failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
