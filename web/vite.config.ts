import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev server for the operator dashboard. On nid-dev this runs behind nginx +
// Cloudflare at overseer.rnm.dev: nginx routes /fleet + /agent to the API and
// everything else here, so HMR must speak wss on 443 (Cloudflare terminates TLS).
// The /fleet proxy is only a fallback for pure-local `npm run dev` (outside the
// box, where nginx isn't in front) — set VITE_API_TARGET to point it at the API.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ["overseer.rnm.dev", ".rnm.dev", "localhost"],
    hmr: { clientPort: 443, protocol: "wss" },
    // In Docker, watch via polling so host edits + rsync reliably trigger HMR.
    watch: process.env.VITE_POLL ? { usePolling: true, interval: 120 } : undefined,
    proxy: {
      "/api": { target: process.env.VITE_API_TARGET ?? "http://localhost:5000", changeOrigin: true },
    },
  },
});
