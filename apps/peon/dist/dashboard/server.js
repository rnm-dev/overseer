import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { settings } from "../daemon/settings/index.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ACA_DASHBOARD_PORT ?? 4571);
// Same knob as the control API (see daemon/index.ts) — this separate process
// reads the shared settings.json at startup. Loopback-only by default; widen
// via `peon remote on`. Restart the dashboard for a change to take effect.
const BIND_HOST = process.env.ACA_BIND_HOST ?? settings.get().bindHost;
if (settings.get().fleetMode === "reverse-only" && !["127.0.0.1", "localhost", "::1"].includes(BIND_HOST)) {
    throw new Error(`reverse-only fleet mode refuses non-loopback dashboard bind host ${BIND_HOST}`);
}
const app = express();
// HTML previews run in a sandboxed iframe whose opaque origin is serialized as
// `null`. Babel standalone loads JSX files with XHR, so the static dashboard
// server must explicitly allow those asset reads when a preview points at the
// live dashboard. This surface serves public assets only; authenticated API
// access remains on the separately-gated control server.
app.use((req, res, next) => {
    if (req.headers.origin === "null") {
        res.setHeader("Access-Control-Allow-Origin", "null");
        res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    if (req.method === "OPTIONS")
        return res.sendStatus(204);
    next();
});
// Brand artwork lives at the package root so the README and the dashboard can
// share one source of truth in both src/ and compiled dist/ layouts.
app.use("/brand", express.static(path.resolve(__dirname, "../../assets")));
app.use(express.static(path.join(__dirname, "public")));
// SPA fallback for real sub-paths (e.g. /sessions/abc123) — express.static
// only serves actual files, so a direct load/refresh needs this to still
// get index.html instead of a 404. Must pass `root` explicitly — without it,
// `send`'s dotfile check runs against the *whole absolute path*, not just the
// requested file, so any hidden ancestor directory in the install path (e.g.
// `~/.local/lib/node_modules/peon`, `~/.nvm/...`) makes it 404 every time
// (confirmed: reproduced and fixed by reproducing this exact directory shape).
app.use((_req, res) => {
    res.sendFile("index.html", { root: path.join(__dirname, "public") });
});
app.listen(PORT, BIND_HOST, () => {
    console.log(`peon dashboard: http://${BIND_HOST}:${PORT}`);
});
