import { config, configWarnings } from "./config.js";
import { initDb } from "./db.js";
import { createServer } from "./server.js";
import { startReconciler } from "./sessionIndex.js";
import { attachLiveSocket } from "./liveSocket.js";
import { pruneEvents } from "./eventLog.js";

// Fail loud if Postgres is unreachable — the overseer has no meaningful degraded
// mode without its system-of-record, so a bad DATABASE_URL should stop the boot
// rather than serve half-broken.
async function main(): Promise<void> {
  await initDb();
  const app = createServer();
  const server = app.listen(config.port, config.host, () => {
    console.log(`overseer: listening on http://${config.host}:${config.port}`);
    for (const w of configWarnings()) console.warn(`WARNING: ${w}`);
    // Rebuild/refresh the session index from every online peon, then keep it
    // fresh on an interval. The peon stays source of truth, so this reconciles
    // any drift a restart introduced.
    startReconciler();
    // Keep the resumable event log bounded (see eventLog.ts).
    setInterval(() => void pruneEvents().catch(() => null), 5 * 60_000);
  });
  // Resumable client transport shares the HTTP server (nginx upgrades /api/ws).
  attachLiveSocket(server);
}

main().catch((err) => {
  console.error("overseer: failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
