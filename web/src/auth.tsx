import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, json, setToken } from "./api";

// Auth state for the dashboard. GitHub returns every flow to this SPA; the SPA
// submits code + state to the API, whose server-backed attempt determines whether
// to finish web login or open the native app with a short-lived code.
// On success we hold a device token (persisted in localStorage) + the user.

export interface User {
  email: string;
  githubLogin?: string | null;
  avatarUrl?: string | null;
}

interface GithubConfig {
  clientId: string;
}

interface GithubStart {
  authorizationUrl: string;
  state: string;
}

// CSRF guard: a random value stashed before the redirect and checked on return.
const STATE_KEY = "overseer_oauth_state";

interface AuthState {
  user: User | null;
  ready: boolean; // finished the initial "am I already logged in?" check
  loginWithGithub: () => Promise<void>;
  completeGithubCallback: (code: string | null, state: string, error: string | null) => Promise<"web" | "native">;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // On boot, if we have a stored token, confirm who we are (or drop a stale one).
  useEffect(() => {
    (async () => {
      if (!getToken()) {
        setReady(true);
        return;
      }
      try {
        const me = await api<{ user?: User }>("/auth/me");
        if (me.user) setUser(me.user);
        else setToken(null);
      } catch {
        setToken(null);
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const value: AuthState = {
    user,
    ready,
    async loginWithGithub() {
      const cfg = await api<GithubConfig>("/auth/github/config");
      if (!cfg.clientId) throw new Error("GitHub sign-in is not configured");
      const started = await api<GithubStart>("/auth/github/start", { method: "POST" });
      sessionStorage.setItem(STATE_KEY, started.state);
      window.location.assign(started.authorizationUrl);
    },
    async completeGithubCallback(code, state, error) {
      const saved = sessionStorage.getItem(STATE_KEY);
      const r = await api<
        | { flow: "web"; token: string; user: User }
        | { flow: "native"; redirectUrl: string }
      >("/auth/github", json({ code, state, error }));
      if (r.flow === "native") {
        const target = new URL(r.redirectUrl);
        if (target.protocol !== "overseer:") throw new Error("invalid native sign-in callback");
        window.location.assign(target.toString());
        return "native";
      }
      sessionStorage.removeItem(STATE_KEY);
      if (!saved || saved !== state) throw new Error("sign-in state mismatch — please try again");
      setToken(r.token);
      setUser(r.user);
      return "web";
    },
    async logout() {
      try {
        await api("/auth/logout", { method: "POST" });
      } catch {
        /* revoke best-effort */
      }
      setToken(null);
      setUser(null);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside AuthProvider");
  return ctx;
}
