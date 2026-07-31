import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "./App";
import { AuthProvider } from "./auth";
import { I18nProvider } from "./i18n";
import { NotificationsProvider } from "./notifications";
import { ThemeProvider } from "./features/themes/ThemeProvider";
import { rememberNativeCallback } from "./nativeLoginMode";
import "./index.css";
import "./features/themes/packages/themes.css";

// Before the router runs: an unauthenticated deep entry redirects to /login and
// drops the query string, which is where the mobile app's callback lives.
rememberNativeCallback(window.location.search, sessionStorage);

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
