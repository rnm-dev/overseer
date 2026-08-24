# Email and password sign-in

GitHub OAuth is no longer the only door. An instance can also accept an email
address and a password, for registration and for sign-in, and the two identities
converge on one user row.

Back to the [documentation index](index.md). How an instance decides which doors
it has at all is in [sign-in methods](sign-in-methods.md).

## The switch

`OVERSEER_PASSWORD_AUTH=1` turns it on. Anything else — including the variable
being absent — turns it off, which is the default everywhere.

The switch covers registration *and* sign-in together: an instance that does not
want local accounts must not accept new ones either. While it is off,
`POST /api/auth/password/register` and `POST /api/auth/password/login` both
answer `503 PASSWORD_AUTH_DISABLED` before looking at the body, so a correct
password on a disabled instance still signs nobody in.

Where it is set:

| Where | Value | File |
| --- | --- | --- |
| Dev (nid-dev) | `1` | `.env`, read by `docker-compose.yml` (gitignored) |
| Production | `1` | `apps/server/config/deploy.yml`, stated explicitly |

Production states its value rather than relying on the default. Opening local
accounts on the public origin is a decision, and the file where production
configuration lives should show that the decision was made. It was made on
2026-08-05: production accepts local accounts, which — because the switch is
one switch — means the registration route is live there too. Who it will accept
is a separate decision, `OVERSEER_OPEN_SIGNUP`, and production has not made it:
registering still needs an invitation. See
[who may become an account](sign-in-methods.md#who-may-become-an-account).

## What a client sees

`GET /api/auth/methods` answers the doors this instance has — `password`,
`github`, `oidc` with its label — plus `openSignup`, whether registration is
open to anyone, without authentication. `github` is true when the OAuth app
credentials are configured. The sign-in page renders from this rather than guessing: a method
switched off in the environment loses its form as well as its route, and the
page shows neither until the answer arrives, so a disabled method never flashes
into view. An unreachable API is treated as "both available" — a transient
failure should leave the page usable, not blank.

## The two routes

Both take `{ email, password }` and answer with the same shape as the OAuth
flow, because they issue the same thing: a device token.

- `POST /api/auth/password/register` → `201`, or `409 EMAIL_TAKEN`,
  `400 INVALID_EMAIL`, `400 WEAK_PASSWORD`.
- `POST /api/auth/password/login` → `200`, or `401 INVALID_CREDENTIALS`.

A browser receives the `__Host-overseer_session` HttpOnly cookie and never the
token. A client that sends `"client": "native"` receives the bearer token in the
body and no cookie, exactly as it does after the OAuth app-code exchange. Both
are rate-limited per IP by the same bucket the OAuth starts use: five
registrations and ten sign-ins a minute.

## Inside the app's webview

There is a third caller, and it can use neither answer. The mobile app opens
`/login?callback=<deep link>` in a system auth session precisely *because* it
cannot use a cookie — that session belongs to the browser, and the app needs a
bearer of its own. A correct password that only set a cookie left the app with
nothing and rendered the whole dashboard inside a sign-in sheet with no way out.

So both routes accept an optional `callback`. When it is present, a correct
credential ends where GitHub and OIDC end: a one-time app code on that deep
link.

```
POST /api/auth/password/login
{ "email": "…", "password": "…", "callback": "overseer://oauth/github" }

200 → { "flow": "native",
        "redirectUrl": "overseer://oauth/github?state=…&code=…" }
```

- The callback is matched **exactly** against `OVERSEER_PASSWORD_NATIVE_CALLBACKS`,
  and anything else is `400 INVALID_CALLBACK`. That is its own setting, not a
  read of the GitHub door's: an instance with `github:false` has no GitHub
  settings to read, and is exactly the instance that needs this most. The
  default names the deep link already-shipped apps open, so turning this door on
  needs no app release.
- **The callback is judged before the credential**, so a misconfigured build is
  told so without a password being hashed, and gets the same answer whether or
  not the address it sent exists.
- **No web session cookie is set.** The browser holding it is the app's sign-in
  sheet and is about to close; the only thing that should survive it is the app
  code, and that lives on the deep link.
- **No device is issued either.** The device is issued when the app spends the
  code, to the client that will actually hold it — otherwise every native
  sign-in would leave a live 90-day credential behind that nothing ever
  receives.
- The code is single-use with a 3-minute TTL, and is redeemed at the shared
  [native exchange](sign-in-methods.md#every-native-sign-in-ends-at-one-exchange).
- A wrong password is still one indistinguishable `401 INVALID_CREDENTIALS`,
  with no redirect.

Without `callback` these routes are byte-for-byte what they were: a browser gets
its cookie and the web dashboard.

Registration creates the default workspace, so the account is usable on its
first request rather than after a second step.

## Passwords

Hashing is scrypt from `node:crypto` — `N=32768, r=8, p=1`, a 16-byte random
salt, a 32-byte key — rather than a new dependency. The cost parameters travel
inside the stored value (`scrypt$N$r$p$salt$hash`), so raising them later leaves
every existing hash verifiable. Node's default 32 MiB scrypt budget is just under
what `N=32768` asks for, which is why `maxmem` is stated explicitly; forgetting
it is an error at hash time, not a silent weakening.

A password must be 10–200 characters and not only whitespace. It is normalised
NFKC before hashing, so a password typed on a different keyboard still matches.

## What the refusals do not say

`401 INVALID_CREDENTIALS` is the answer to a wrong password, to an unknown
address, and to an address whose account has no password at all. The body is
byte-identical in every case, and an unknown address still spends comparable
scrypt work before answering, so neither the response nor its timing tells an
attacker which addresses have accounts.

Registration cannot hide the same fact — `409 EMAIL_TAKEN` is what an honest
sign-up form owes the person filling it in — and on an instance with open
sign-up that is not a leak worth a worse form.

## How the two identities meet

`users.password_hash` is nullable. NULL means the account has no password, which
is every GitHub-created user and not an error state.

Linking already worked and was not changed: `ensureUserFromGithub` finds an
existing row by email and stamps `github_id` onto it. So an account registered
with a password, whose owner later signs in with GitHub on the same address,
stays one account. There is no reverse operation yet — a GitHub-only account
cannot be given a password from the UI, and its owner keeps using GitHub.

Addresses are compared case-insensitively on the password routes even though the
column's unique index is not: GitHub supplies an email verbatim, so an older row
may carry capitals that a person typing the same address would not reproduce.
Registration stores the address lowercased.
