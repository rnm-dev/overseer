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
