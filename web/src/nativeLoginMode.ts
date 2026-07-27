// The mobile app signs in by opening this SPA in a webview at
// /login?callback=<app deep link>, so every sign-in option stays web-owned and
// the app never reimplements a provider. The presence of `callback` IS the
// native mode — no separate flag that could drift out of sync with it.
//
// The value is remembered for the browsing session because both the GitHub
// round trip and a "back to login" retry arrive without the query string.
//
// The real allowlist is server-side (OVERSEER_GITHUB_NATIVE_CALLBACKS, matched
// exactly when the native flow starts). This only refuses web URLs, so a stray
// ?callback=https://… cannot push a plain browser into a flow that ends at a
// deep link it can never open. The stored value stays verbatim — the server
// compares it literally, so normalizing here could only break the match.

const NATIVE_CALLBACK_KEY = "overseer_native_callback";

// The slice of sessionStorage this needs — lets tests pass a plain object.
export interface CallbackStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function isDeepLink(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol !== "http:" && protocol !== "https:";
  } catch {
    return false;
  }
}

// Call once at startup, before routing can strip the query string.
export function rememberNativeCallback(search: string, store: CallbackStore): string | null {
  const fresh = new URLSearchParams(search).get("callback");
  if (fresh && isDeepLink(fresh)) store.setItem(NATIVE_CALLBACK_KEY, fresh);
  return nativeCallback(store);
}

export function nativeCallback(store: CallbackStore): string | null {
  return store.getItem(NATIVE_CALLBACK_KEY);
}

export function forgetNativeCallback(store: CallbackStore): void {
  store.removeItem(NATIVE_CALLBACK_KEY);
}

// Where /login goes. A signed-in browser belongs on the dashboard, but a
// signed-in *webview* does not: the app opened it to obtain a deep link, and
// bouncing to the dashboard would render the whole of Overseer inside the app's
// sign-in sheet with no way to finish. Native mode outranks the web session —
// the flow is public and session-independent server-side, so the GitHub round
// trip completes into overseer://oauth/github either way.
export function loginRouteTarget(signedIn: boolean, store: CallbackStore): "dashboard" | "login" {
  return signedIn && !nativeCallback(store) ? "dashboard" : "login";
}
