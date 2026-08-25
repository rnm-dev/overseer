import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { api, ApiError, getToken, json, migrateLegacyWebSession, setToken } from "../../shared/api";
import { clearTranscriptSnapshotCache } from "../sessions/transcriptSnapshotCache";
import { providerStartBody } from "./inviteFlow";
import { getOrStartAuthBootstrap } from "./authBootstrap";
import { forgetNativeCallback, nativeCallback } from "./nativeLoginMode";
import { serverApprovedNativeRedirect } from "./nativeOauthRedirect";

// Auth state for the dashboard. Every redirect provider — GitHub, and an
// instance's OIDC provider — returns each flow to this SPA; the SPA submits code
// + state to the API, whose server-backed attempt determines whether to finish
// web login or open the native app with a short-lived code. The two differ only
// in which pair of endpoints they use, so they share one code path here.
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

/** The redirect-based doors. Each owns `/auth/<provider>` and its two starts. */
export type OauthProvider = "github" | "oidc";

interface OauthStart {
  authorizationUrl: string;
  state: string;
}

// CSRF guard: a random value stashed before the redirect and checked on return.
const STATE_KEY = "overseer_oauth_state";

interface AuthState {
  user: User | null;
  ready: boolean; // finished the initial "am I already logged in?" check
  unavailable: boolean;
  retry: () => Promise<void>;
  loginWithProvider: (provider: OauthProvider, invite?: string | null) => Promise<void>;
  // "native" means the browser has been sent to the app's deep link and this
  // page is on its way out — there is no user to show and nothing to navigate to.
  signInWithPassword: (email: string, password: string) => Promise<"web" | "native">;
  // The invite, when the visitor arrived from one: it is what permits the
  // account on an instance that is not open, and it is spent on the workspace
  // that issued it, so the person lands there instead of alone in a personal one.
  registerWithPassword: (email: string, password: string, invite?: string | null) => Promise<"web" | "native">;
  completeOauthCallback: (
    provider: OauthProvider,
    code: string | null,
    state: string,
    error: string | null,
  ) => Promise<"web" | "native">;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export type InitialAuth =
  | { kind: "authenticated"; user: User }
  | { kind: "unauthenticated" }
  | { kind: "unavailable" };

interface AuthBootstrapDependencies {
  legacyToken: () => string | null;
  migrateLegacySession: (token: string) => Promise<void>;
  clearLegacyToken: () => void;
  loadUser: () => Promise<{ user?: User }>;
}

export async function loadInitialAuth(
  dependencies: AuthBootstrapDependencies = {
    legacyToken: getToken,
    migrateLegacySession: migrateLegacyWebSession,
    clearLegacyToken: () => setToken(null),
    loadUser: () => api<{ user?: User }>("/auth/me"),
  },
): Promise<InitialAuth> {
  try {
    const legacyToken = dependencies.legacyToken();
    if (legacyToken) {
      try {
        await dependencies.migrateLegacySession(legacyToken);
        dependencies.clearLegacyToken();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 401) {
          return { kind: "unavailable" };
        }
        dependencies.clearLegacyToken();
      }
    }
    const me = await dependencies.loadUser();
    return me.user
      ? { kind: "authenticated", user: me.user }
      : { kind: "unauthenticated" };
  } catch (error) {
    return error instanceof ApiError && error.status === 401
      ? { kind: "unauthenticated" }
      : { kind: "unavailable" };
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const bootstrapRef = useRef<Promise<InitialAuth>>(null);

  async function restore(): Promise<void> {
    setReady(false);
    setUnavailable(false);
    bootstrapRef.current = null;
    const initial = await getOrStartAuthBootstrap(bootstrapRef, loadInitialAuth);
    if (initial.kind === "authenticated") setUser(initial.user);
    else if (initial.kind === "unauthenticated") setUser(null);
    setUnavailable(initial.kind === "unavailable");
    setReady(true);
  }

  // One-release migration: exchange a legacy localStorage bearer for an
  // HttpOnly cookie, then erase the JavaScript-readable credential.
  useEffect(() => {
    let active = true;
    void getOrStartAuthBootstrap(bootstrapRef, loadInitialAuth).then((initial) => {
      if (!active) return;
      if (initial.kind === "authenticated") setUser(initial.user);
      else if (initial.kind === "unauthenticated") setUser(null);
      setUnavailable(initial.kind === "unavailable");
      setReady(true);
    });
    return () => {
      active = false;
    };
  }, []);

  // Both password routes answer the same two ways, so they ask the same way.
  async function passwordDoor(path: string, credentials: Record<string, string>): Promise<"web" | "native"> {
    const callback = nativeCallback(sessionStorage);
    const r = await api<{ user: User } | { flow: "native"; redirectUrl: string }>(
      path,
      json(callback ? { ...credentials, callback } : credentials),
    );
    if ("flow" in r && r.flow === "native") {
      // Deliberately no forgetNativeCallback: this browser is still the app's
      // sign-in sheet, and a "back to login" retry has to stay in native mode.
      window.location.assign(serverApprovedNativeRedirect(r.redirectUrl));
      return "native";
    }
    forgetNativeCallback(sessionStorage); // a finished web sign-in ⇒ not a webview
    clearTranscriptSnapshotCache();
    setUser((r as { user: User }).user);
    return "web";
  }

  const value: AuthState = {
    user,
    ready,
    unavailable,
    retry: restore,
    async loginWithProvider(provider, invite) {
      // No preflight for "is this method configured": the start route below is
      // the one authority on that and refuses with 503 itself, so asking first
      // could only disagree with it.
      const callback = nativeCallback(sessionStorage);
      const body = providerStartBody(callback, invite ?? null);
      const started = callback
        ? await api<OauthStart>(`/auth/${provider}/native/start`, json(body))
        : await api<OauthStart>(`/auth/${provider}/start`, json(body));
      sessionStorage.setItem(STATE_KEY, started.state);
      window.location.assign(started.authorizationUrl);
    },
    // Email + password. In a browser the session is the same HttpOnly cookie
    // GitHub sign-in issues, so nothing below this line knows which door the
    // user came through.
    //
    // In the app's webview there is no cookie to have: the callback is sent with
    // the credentials, and the server answers with the deep link carrying a
    // one-time app code — the same ending the redirect doors reach, so the app
    // exchanges it the same way. Rendering the dashboard here instead is the bug
    // this closes: it puts the whole product inside a sign-in sheet that has no
    // way to hand the app a token.
    async signInWithPassword(email, password) {
      return passwordDoor("/auth/password/login", { email, password });
    },
    async registerWithPassword(email, password, invite) {
      return passwordDoor("/auth/password/register", invite ? { email, password, invite } : { email, password });
    },
    async completeOauthCallback(provider, code, state, error) {
      const saved = sessionStorage.getItem(STATE_KEY);
      const r = await api<
        | { flow: "web"; user: User }
        | { flow: "native"; redirectUrl: string }
      >(`/auth/${provider}`, json({ code, state, error }));
      if (r.flow === "native") {
        window.location.assign(serverApprovedNativeRedirect(r.redirectUrl));
        return "native";
      }
      sessionStorage.removeItem(STATE_KEY);
      forgetNativeCallback(sessionStorage); // a finished web sign-in ⇒ not a webview
      if (!saved || saved !== state) throw new Error("sign-in state mismatch — please try again");
      clearTranscriptSnapshotCache();
      setUser(r.user);
      return "web";
    },
    async logout() {
      try {
        await api("/auth/logout", { method: "POST" });
      } catch {
        /* revoke best-effort */
      }
      clearTranscriptSnapshotCache();
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
