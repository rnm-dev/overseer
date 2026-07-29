import { execFile } from "node:child_process";

const enabled = Boolean(process.env.NOTIFY_SOCKET);

function notify(state: string): void {
  if (!enabled) return;
  execFile("systemd-notify", [state], (err) => {
    if (err) console.error("systemd-notify failed:", err.message);
  });
}

export const sdNotify = {
  ready(): void {
    notify("READY=1");
  },
  watchdog(): void {
    notify("WATCHDOG=1");
  },
  stopping(): void {
    notify("STOPPING=1");
  },
  // Half the systemd-configured watchdog interval, per sd_notify(3) guidance.
  watchdogIntervalMs(): number | null {
    const usec = Number(process.env.WATCHDOG_USEC ?? 0);
    return usec > 0 ? Math.floor(usec / 2 / 1000) : null;
  },
};
