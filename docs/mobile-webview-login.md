# Mobile webview login

The mobile app does not implement sign-in providers itself. It opens a webview
on the Overseer login screen, and every option lives there. Adding a provider is
then a web change only — no app release.

## The contract

The app opens:

```
https://overseer.rnm.dev/login?callback=overseer://oauth/github
```

Dev builds use `https://overseer-dev.rnm.dev/login?callback=overseer-dev://oauth/github`.

**The presence of `callback` is the native mode.** There is no separate flag —
one source of truth, nothing to drift out of sync. Rules:

- The value must be a non-`http(s)` deep link, or the SPA ignores it and stays
  in plain web mode (`apps/web/src/features/auth/nativeLoginMode.ts`).
- The API matches it **exactly** against `OVERSEER_GITHUB_NATIVE_CALLBACKS`
  (`overseer://oauth/github` and `overseer-dev://oauth/github` today). Anything
  else gets `400 INVALID_CALLBACK` when sign-in starts, so the login page owns
  no allowlist of its own.
- The SPA keeps the callback in `sessionStorage` for the browsing session,
  because the GitHub round trip and a "back to login" retry both come back
  without a query string. A completed web sign-in clears it.
- **An armed callback outranks an existing web session on `/login`.** The system
  auth session shares the browser's cookies (§2), so the webview usually opens
  *already signed in*; the ordinary "signed in ⇒ go to the dashboard" redirect
  would render the whole of Overseer inside the app's sign-in sheet with no way
  to reach the deep link. `loginRouteTarget` in `apps/web/src/features/auth/nativeLoginMode.ts`
  decides this and is covered by tests. The native flow is public and
  session-independent server-side, so the round trip below completes either way.

## The round trip

1. App opens the webview at `/login?callback=…`.
2. The login button calls `POST /api/auth/github/native/start` with that
   callback. The API stores `flow='native'` alongside the OAuth state and
   returns GitHub's authorization URL.
3. GitHub returns to `https://<origin>/auth/github/callback`, the same page both
   flows use. It posts `code + state` to `POST /api/auth/github`.
4. Because the flow is recorded server-side with the state, the API answers
   `{flow:"native", redirectUrl:"overseer://oauth/github?state=…&code=…"}` and
   the page navigates to that deep link.
5. The app captures the deep link and calls
   `POST /api/auth/github/native/exchange` with `state + code` to get its device
   token. The app code is single-use and expires in 3 minutes.

Steps 3–5 are unchanged from the older flow where the app opened GitHub
directly, so only the entry point moves.

## What the app has to do

The server side is complete; everything below is app work.

### 1. Pin the origin/scheme pair per build

| build | origin | callback |
| --- | --- | --- |
| production | `https://overseer.rnm.dev` | `overseer://oauth/github` |
| dev | `https://overseer-dev.rnm.dev` | `overseer-dev://oauth/github` |

Both schemes are allowlisted on **both** servers today, so a dev build can be
pointed at either origin. Ship them as one build-config pair anyway — a mismatch
surfaces only as a `400 INVALID_CALLBACK` at the moment the user taps sign-in.

### 2. Open the login screen in a system auth session

Build `<origin>/login?callback=<callback>` with the callback **percent-encoded**
in the query, then open it with:

- **iOS** — `ASWebAuthenticationSession(url:callbackURLScheme:"overseer")`. It
  captures the scheme itself, so no `Info.plist` registration and no navigation
  interception are needed.
- **Android** — Chrome Custom Tabs, with an `intent-filter` on
  `scheme="overseer" host="oauth" path="/github"`.

Do **not** use a raw `WKWebView`/`WebView`: it has its own cookie jar, so the
user retypes their GitHub password on every sign-in, and it makes you intercept
navigation by hand. The system session shares the browser's cookies, which is
what makes a returning user's login a single tap.

### 3. Accept the deep link only while a login is in flight

The app never sees the OAuth `state` up front — the login page starts the flow,
so `state` first reaches the app inside the callback deep link and there is
nothing local to compare it against. That means an arbitrary app on the device
could fire `overseer://oauth/github?state=…&code=…` and, if you exchange it
blindly, log the user into **someone else's account**.

`ASWebAuthenticationSession` closes this by construction: the callback is
delivered to that session's completion handler, never to a global URL handler.
On Android the intent-filter *is* global, so gate it explicitly — ignore the
intent unless the app itself started a login flow (and handle both `onNewIntent`
and a cold start via `getIntent`, since the intent can launch the app fresh).

### 4. Exchange the app code for a device token

```
POST <origin>/api/auth/github/native/exchange
{ "state": "<from the deep link>", "code": "<from the deep link>" }

200 → { "token": "<deviceId>.<secret>",
        "user":   { "email", "githubLogin", "avatarUrl" },
        "device": { "id", "label", "createdAt", "lastSeenAt", "expiresAt" } }
```

If the deep link carries `error` instead of `code`, sign-in failed or was
denied — show it and let the user retry.

Treat `token` as opaque and store it in the Keychain / EncryptedSharedPreferences.
It is the credential for everything else: `Authorization: Bearer <token>` on
`/api/*`. `device.expiresAt` is epoch-ms, 90 days out by default
(`OVERSEER_DEVICE_TOKEN_TTL_MS`).

For the live socket, call `POST /api/auth/ws-ticket` with that bearer and use
the returned `ticket` — it is single-use and lives 30 seconds, so fetch a fresh
one per connect, not once per session.

### 5. Handle the failure modes

| what happened | response | app behaviour |
| --- | --- | --- |
| callback not allowlisted | `400 INVALID_CALLBACK` on start | build misconfigured; fail loudly in dev |
| GitHub not configured | `503 GITHUB_DISABLED` | show "sign-in unavailable" |
| too many attempts | `429 RATE_LIMITED` | 10 starts/min, 20 exchanges/min per IP; back off |
| user idled on GitHub | state expires after 5 min | restart the flow |
| code reused or stale | `400 BAD_APP_CODE` | app code is single-use, 3 min TTL; restart the flow |
| token revoked or expired | `401` on any `/api/*` | wipe the stored token, reopen the login screen |

Errors that happen *before* the deep link render inside the webview and no
callback ever fires — always give the user a visible way to dismiss it, or the
session is a dead end.

Sign-out is `POST /api/auth/logout` with the bearer: it revokes that device only
(and disables its push subscriptions), so other devices stay signed in.

### Known gap: invites

The SPA keeps a pending invite token in `sessionStorage` and consumes it after a
**web** sign-in only. An invite opened on a phone therefore needs the app to
navigate to `/join/<token>` itself once login finishes.
