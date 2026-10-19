import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AuthProvider } from "../features/auth/auth";
import { I18nProvider } from "../shared/i18n";
import { NotificationsProvider } from "../shared/notifications";
import { ThemeProvider } from "../features/themes/ThemeProvider";
import { rememberNativeCallback } from "../features/auth/nativeLoginMode";
import { trackScrollbarWidth } from "../shared/scrollbarWidth";
import "./index.css";

// Before the router runs: an unauthenticated deep entry redirects to /login and
// drops the query string, which is where the mobile app's callback lives.
rememberNativeCallback(window.location.search, sessionStorage);

// Publishes --ov-scrollbar-width so fixed overlays can keep off the scrollbar.
trackScrollbarWidth(window);

// A stale deploy's lazy chunk 404s: reload once to pick up the new build.
window.addEventListener("vite:preloadError", (event) => {
  if (sessionStorage.getItem("ov-preload-reload")) return;
  event.preventDefault();
  sessionStorage.setItem("ov-preload-reload", "1");
  location.reload();
});
// Cleared after the page has stayed up a while, so a persistently missing chunk cannot loop.
window.addEventListener("load", () => window.setTimeout(() => sessionStorage.removeItem("ov-preload-reload"), 10000));

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <NotificationsProvider>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </NotificationsProvider>
      </I18nProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
