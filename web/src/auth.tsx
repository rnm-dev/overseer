import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { api, getToken, json, setToken } from "./api";

// Auth state for the dashboard. Sign-in is GitHub OAuth, SPA-driven:
//   loginWithGithub()      → redirect the browser to GitHub's authorize URL
//   (GitHub → /auth/github/callback in the SPA)
//   completeGithubCallback → verify state, trade the code for a device token
// On success we hold a device token (persisted in localStorage) + the user.

export interface User {
  email: string;
  githubLogin?: string | null;
  avatarUrl?: string | null;
}

interface GithubConfig {
  clientId: string;
  scope: string;
  redirectUri: string;
}

// CSRF guard: a random value stashed before the redirect and checked on return.
const STATE_KEY = "overseer_oauth_state";

interface AuthState {
  user: User | null;
  ready: boolean; // finished the initial "am I already logged in?" check
  loginWithGithub: () => Promise<void>;
  completeGithubCallback: (code: string, state: string) => Promise<void>;
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
      const state = crypto.randomUUID();
      sessionStorage.setItem(STATE_KEY, state);
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", cfg.redirectUri);
      url.searchParams.set("scope", cfg.scope);
      url.searchParams.set("state", state);
      window.location.assign(url.toString());
    },
    async completeGithubCallback(code, state) {
      const saved = sessionStorage.getItem(STATE_KEY);
      sessionStorage.removeItem(STATE_KEY);
      if (!saved || saved !== state) throw new Error("sign-in state mismatch — please try again");
      const r = await api<{ token: string; user: User }>("/auth/github", json({ code }));
      setToken(r.token);
      setUser(r.user);
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
