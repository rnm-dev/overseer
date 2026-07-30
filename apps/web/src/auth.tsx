import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, getToken, json, migrateLegacyWebSession, setToken } from "./api";
import { getOrStartAuthBootstrap } from "./authBootstrap";
import { forgetNativeCallback, nativeCallback } from "./nativeLoginMode";
import { serverApprovedNativeRedirect } from "./nativeOauthRedirect";

// Auth state for the dashboard. GitHub returns every flow to this SPA; the SPA
// submits code + state to the API, whose server-backed attempt determines whether
// to finish web login or open the native app with a short-lived code.
// Web sessions use an HttpOnly cookie. Native clients retain bearer tokens.
//
// A webview launched by the mobile app carries a deep-link callback (see
// nativeLoginMode). It only changes which start endpoint we call: the flow is
// recorded server-side with the OAuth state, so the callback page below reads
// the answer back without knowing which mode it is in.

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

async function loadInitialUser(): Promise<User | null> {
  try {
    const legacyToken = getToken();
    if (legacyToken) {
      await migrateLegacyWebSession(legacyToken);
      setToken(null);
    }
    const me = await api<{ user?: User }>("/auth/me");
    return me.user ?? null;
  } catch {
    setToken(null);
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const bootstrapRef = useRef<Promise<User | null>>(null);

  // One-release migration: exchange a legacy localStorage bearer for an
  // HttpOnly cookie, then erase the JavaScript-readable credential.
  useEffect(() => {
    let active = true;
    void getOrStartAuthBootstrap(bootstrapRef, loadInitialUser).then((initialUser) => {
      if (!active) return;
      if (initialUser) setUser(initialUser);
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  const value: AuthState = {
    user,
    ready,
    async loginWithGithub() {
      const cfg = await api<GithubConfig>("/auth/github/config");
      if (!cfg.clientId) throw new Error("GitHub sign-in is not configured");
      const callback = nativeCallback(sessionStorage);
      const started = callback
        ? await api<GithubStart>("/auth/github/native/start", json({ callback }))
        : await api<GithubStart>("/auth/github/start", { method: "POST" });
      sessionStorage.setItem(STATE_KEY, started.state);
      window.location.assign(started.authorizationUrl);
    },
    async completeGithubCallback(code, state, error) {
      const saved = sessionStorage.getItem(STATE_KEY);
      const r = await api<
        | { flow: "web"; user: User }
        | { flow: "native"; redirectUrl: string }
      >("/auth/github", json({ code, state, error }));
      if (r.flow === "native") {
        window.location.assign(serverApprovedNativeRedirect(r.redirectUrl));
        return "native";
      }
      sessionStorage.removeItem(STATE_KEY);
      forgetNativeCallback(sessionStorage); // a finished web sign-in ⇒ not a webview
      if (!saved || saved !== state) throw new Error("sign-in state mismatch — please try again");
      setUser(r.user);
      return "web";
    },
    async logout() {
      try {
        await api("/auth/logout", { method: "POST" });
      } catch {
        /* revoke best-effort */
      }
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
