import { config, configWarnings } from "./infrastructure/config/index.js";
import { initDb } from "./infrastructure/db/index.js";
import { createServer } from "./server.js";
import { startReconciler } from "./sessionIndex.js";
import { attachLiveSocket } from "./liveSocket.js";
import { attachPeonSocket } from "./peonSocket.js";
import { pruneEvents } from "./infrastructure/events/index.js";
import { startPushWorker } from "./push.js";
import { pruneTranscriptProjection } from "./modules/sessions/index.js";
import { configureEventDelivery } from "./app/eventDelivery.js";

// Fail loud if Postgres is unreachable — the overseer has no meaningful degraded
// mode without its system-of-record, so a bad DATABASE_URL should stop the boot
// rather than serve half-broken.
async function main(): Promise<void> {
  await initDb();
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
    setInterval(() => void pruneTranscriptProjection().catch(() => null), 5 * 60_000);
  });
  // Resumable client transport shares the HTTP server (nginx upgrades /api/ws).
  attachLiveSocket(server);
  attachPeonSocket(server);
}

main().catch((err) => {
  console.error("overseer: failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
