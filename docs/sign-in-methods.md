# Sign-in methods

Overseer has three doors: GitHub OAuth, [email + password](password-auth.md) and
[OpenID Connect](#openid-connect). Whichever one an operator comes through, they
end holding the same thing — a device token, as a browser cookie or a native
bearer — so nothing past the door knows which one it was.

Back to the [documentation index](index.md).

## One resolver decides what exists

`infrastructure/auth/authConfig.ts` turns the environment into `config.auth`,
next to the resolvers `infrastructure/voice` and `infrastructure/push` already
use. It is pure — the environment is an argument, not an import — so precedence
is testable without touching `process.env`.

A method is its settings or `null`. There is no separate enabled flag to
disagree with them, and nothing outside the resolver re-derives availability:

```
config.auth.github    GithubAuthSettings | null   // id, secret, scope, redirect, native callbacks
config.auth.oidc      OidcAuthSettings | null     // issuer, id, secret, scope, redirect, callbacks, label
config.auth.password  boolean                     // OVERSEER_PASSWORD_AUTH=1
```

| Variable | Effect |
| --- | --- |
| `OVERSEER_GITHUB_CLIENT_ID` + `OVERSEER_GITHUB_CLIENT_SECRET` | both set → GitHub is on |
| `OVERSEER_GITHUB_SCOPE` | default `read:user user:email` |
| `OVERSEER_GITHUB_REDIRECT_URI` | default `${OVERSEER_PUBLIC_URL}/auth/github/callback` |
| `OVERSEER_GITHUB_NATIVE_CALLBACKS` | allowlisted deep links, default `overseer://oauth/github` |
| `OVERSEER_OIDC_ISSUER` + `OVERSEER_OIDC_CLIENT_ID` + `OVERSEER_OIDC_CLIENT_SECRET` | all three set → OIDC is on |
| `OVERSEER_OIDC_SCOPE` | default `openid profile email`; `openid` is added if left out |
| `OVERSEER_OIDC_REDIRECT_URI` | default `${OVERSEER_PUBLIC_URL}/auth/oidc/callback` |
| `OVERSEER_OIDC_NATIVE_CALLBACKS` | allowlisted deep links, default `overseer://oauth/oidc` |
| `OVERSEER_OIDC_LABEL` | what the button says, default the issuer's host |
| `OVERSEER_OIDC_JOIN_WORKSPACE` | slug of the workspace everyone from this directory joins — see [joining a workspace](#joining-a-workspace) |
| `OVERSEER_OIDC_WORKSPACE_CLAIM` | claim naming the workspaces an operator joins, when one directory holds several teams |
| `OVERSEER_OIDC_PROVISION_WORKSPACE=1` | this directory gets a workspace of its own, made by whoever arrives from it first |
| `OVERSEER_PASSWORD_AUTH=1` | email + password is on, for registration and sign-in together |
| `OVERSEER_DEVICE_TOKEN_TTL_MS` | lifetime of the token every door issues, default 90 days |

The issuer must be `https` and is normalised once — trailing slash removed — so
the `iss` claim can later be compared byte for byte. **Half a provider is no
provider**, for either door.

**Half a GitHub app is no GitHub app.** A client id without its secret used to
leave the method advertising a client id to the SPA while every start route
answered `503`, which sent a person to GitHub and back to a dead end. It now
resolves to `null` with a startup warning naming the missing half. An instance
with no method at all warns that nobody can log in.

## One guard enforces it

Admission to any sign-in route — is the method configured, has this address had
enough attempts this minute — is `routes/authMethodAccess.ts`. Each method's
settings are read through its guard there (`githubApp(res)`, `oidcProvider(res)`,
`passwordAuthOpen(res)`), which either hands back the settings or writes the
refusal. Every route of that method goes through it, including the ones
completing a flow already in the air: turning the method off stops an
outstanding state *or app code* from being redeemed, rather than only refusing
new starts. The password routes check before they look at the body, so a correct
password on a disabled instance still signs nobody in.

## The doors are written once

GitHub and OIDC are the same shape — start a flow, send the person away, take
back a code against a single-use state, end holding an account — so
`routes/authRedirectSignIn.ts` implements that shape once and names what differs
in a descriptor per provider: its guard, its callback page, its denial code, its
start and complete functions, and how its own failures map to a status. Adding a
third redirect provider is a descriptor, not another copy of the flow.

This is not deduplication for its own sake. Two hand-written copies of a sign-in
flow drift, and the half that drifts is the error path — the one nobody
exercises until it matters. Email + password, which is not a redirect flow, is
`routes/authPasswordRoutes.ts`; `routes/auth.ts` composes the three and holds
only what belongs to none of them.

An identity can be proved and still not have an account: an unverified address,
an address already linked to another subject. Those are `AccountLinkError` from
`modules/auth`, not a provider's protocol error, because the rule is Overseer's
and applies to every door — the transport answers them before it reaches any
provider-specific mapping.

Refusals keep their stable codes — `503 GITHUB_DISABLED`,
`503 OIDC_DISABLED` and `503 PASSWORD_AUTH_DISABLED` — and the deepest layer holds the same line:
`exchangeCodeForProfile` throws `GITHUB_DISABLED` rather than posting empty
credentials to GitHub if a request ever reaches it past a guard.

## What a client sees

`GET /api/auth/methods` answers
`{ "github": boolean, "password": boolean, "oidc": boolean, "oidcLabel": string | null }`
without authentication, straight from `authMethodAvailability(config.auth)` plus
the one thing a client cannot derive: what to call a provider only this instance
knows about. The
sign-in page renders from it rather than guessing, and shows neither door until
the answer arrives so a disabled method never flashes into view; an unreachable
API is treated as "both available", because a transient failure should leave the
page usable rather than blank.

There is no `GET /api/auth/github/config`. It existed so the SPA could check for
a client id before starting, which is a second opinion on a question
`POST /api/auth/github/start` already answers — one round trip and one published
client id for nothing.

## Who may become an account

**By default, only an invitation makes an account.** Possession of the token is
the capability, exactly as it already is for joining a workspace, and the
invitation is spent on the account it admitted so an invited person lands in the
workspace they were invited to. Refusals are `403 SIGNUP_CLOSED` on the password
route and the same code through the redirect flow.

That default is the one this product is usually deployed under — one operator's
instance, or one team's, reachable from the public internet — so it is what an
instance does when nobody has said otherwise.

**`OVERSEER_OPEN_SIGNUP=1` says otherwise.** Anyone who can reach the instance
may then hold an account on it, through every door: `mayCreateAccount` answers
yes before it looks for a token, so password registration and the GitHub
redirect both open together. Splitting it per door was rejected — it is a
statement about who the instance is for, and an instance that will take
strangers takes them through whichever door they knock on.

What an uninvited account gets is a personal workspace and nothing else.
`ensureDefaultWorkspace` runs for every new account whichever door it came
through, so the account is usable on its own, and no existing workspace becomes
reachable without an invitation to *it*. The switch decides who may hold an
account here; it never decides what an account reaches.

OIDC ignores the switch in both positions, for the reason below: a configured
single-tenant issuer is already the invitation.

The sign-in page reads the answer from `GET /api/auth/methods`, which carries
`openSignup` beside the doors, and offers to register only when the instance
would accept it — or when the visitor arrived from an invite link, which the
page passes to the registration it permits. The page is not the guard: every
registration is checked again on the server.

An invitation has to survive the redirect. A GitHub account is created at the end
of a flow that began before anyone could present anything, so `POST /api/auth/github/start`
accepts an `invite` and stores it on the attempt row (`oauth_attempts.invite_token`),
where completing the flow reads it back. Without that, an invite-only instance
could invite nobody who did not already have an account — a rule with no way in.

**OIDC is exempt, deliberately.** A configured single-tenant issuer *is* the
invitation: this instance named that directory, `iss` is compared byte for byte,
and an administrator there decided this person has an account. Gating it would
also make [the directory's own workspace](#the-directorys-own-workspace)
impossible, where the first arrival is supposed to bring the workspace into
being. So an instance running only OIDC needs no invitations and no public door.

### Standing an instance up

An instance with OIDC needs none of this: the first person from the directory
signs in like any other, and with `OVERSEER_OIDC_PROVISION_WORKSPACE=1` their
arrival is what creates the workspace they own. The exemption above and the
provisioning are the same idea — the directory admitted them, so nothing here
has to.

Everywhere else the first account is the awkward one: there is nobody to invite
anybody. Registration answers it. Bring the instance up with
`OVERSEER_OPEN_SIGNUP=1`, register at its public URL like any other operator —
the arrival gets a workspace of their own, exactly as every account does — then
remove the variable and restart. The instance is invite-only again from the next
request, and everyone after the first is invited from inside the product by
somebody who can see what they are inviting them to.

The window is the honest part of this, and it is as small as the operator makes
it: an instance is open only between its first boot and its second, and only if
nobody else reaches it in between. An instance that is not public yet — bound to
loopback, or behind a proxy that is not serving it — has no window at all.

There used to be an `admin bootstrap` subcommand here that made an unclaimed
workspace and printed a one-time owner link. It was removed in 0.4.0: it asked
the first operator to find a shell inside a container before they had seen the
product, to solve a problem registration already solves. What remains of the CLI
is `invite`, `users`, `promote` and `demote` — the last two are the only answer
to a workspace whose last owner has left, which nothing inside the product can
fix. It is run through `node`, since the image puts nothing on `PATH`:

```
docker compose exec app node dist/index.js admin users
```

## OpenID Connect

The generic door. An instance names an issuer and a client, and everything else
— endpoints, signing keys — comes from the provider's own discovery document at
`${issuer}/.well-known/openid-configuration`, cached for an hour. Nothing about a
provider is configured route by route, which is why adding a second provider
later is configuration and not code.

The first one deployed against it is `https://id.rnm.dev`: authorization code
only, RS256 id tokens, PKCE `S256`, scopes `openid profile email workspace`.

### The flow

1. `POST /api/auth/oidc/start` (or `/native/start` with an allowlisted deep
   link) mints an opaque state, a nonce and a PKCE verifier, stores all three
   server-side against that state, and returns the provider's authorization URL.
   The browser is handed the URL and the state — never the verifier, the nonce
   or the client secret. Discovery happens *before* the attempt is stored, so an
   unreachable provider fails the start instead of leaving a row nobody can redeem.
2. The provider returns the person to `/auth/oidc/callback` in the SPA, which
   submits code + state to `POST /api/auth/oidc`.
3. The state is consumed once, and only at the door that minted it — an attempt
   row carries its `provider`, so an OIDC state presented at `/api/auth/github`
   is `400 BAD_STATE` rather than a cross-provider confusion.
4. The code is exchanged at the token endpoint with `client_secret_basic` and
   the PKCE verifier.
5. The id token is verified locally before anything is believed: RS256 signature
   against the discovered JWKS, then issuer, audience (and `azp` when there are
   several), expiry and issued-at within a minute of skew, an age under ten
   minutes, and this attempt's nonce.
6. The identity becomes a session exactly as GitHub's does — default workspace,
   then a cookie for a browser or a one-time app code for a native client, which
   `POST /api/auth/oidc/native/exchange` redeems. That exchange is fenced by
   provider like the state it grew from, so an app code minted at one door is not
   spendable at the other's.

### What is deliberately strict

- **RS256 only.** An allowlist of one is how `alg: "none"` and the
  HMAC-with-the-public-key confusion stop being reachable at all. Verification is
  `node:crypto` over the published JWK — no JWT dependency, the same choice
  scrypt represents for passwords.
- **The nonce is required**, and only its digest is stored, so the binding
  survives a look at the attempts table.
- **An unverified email is refused.** Identity is `(issuer, subject)`, but email
  is how an OIDC identity *meets* an account that already exists under another
  door. A provider that lets a person claim any address would otherwise let them
  claim an operator's account with it. But **absent and `false` are different
  statements**: a provider that omits the claim has not spoken to the question,
  and this instance named its issuer, so the address is taken at face value.
  `email_verified: false` is the provider speaking, and is believed. It speaks
  about `email`, so an address that came from a fallback claim is not refused
  over a statement about a value nobody read.
- **One account holds one OIDC identity.** A second subject arriving on a linked
  address is `IDENTITY_CONFLICT`, not a silent re-point.
- **A rotated signing key is refetched once**, then not again for a minute, so a
  forged token cannot turn every verification into traffic at the provider.
- **A provider that advertises its challenge methods without `S256`** is refused
  at the start, where it is a configuration fault with a name, rather than at the
  redirect. Advertising nothing is not a refusal: it still gets `S256`.

### Joining a workspace

Every other door ends at `ensureDefaultWorkspace`, which gives an operator with
no membership a personal workspace named after their address. For a company
signing in through its own directory that is the wrong destination: the new hire
lands alone, and someone has to notice and send an invite link.

`OVERSEER_OIDC_JOIN_WORKSPACE=<slug>` makes everyone who comes through this door
a member of that workspace instead, before the personal fallback runs. No claim
decides it and none needs to: the issuer is single-tenant and compared byte for
byte, so arriving at this door already means being in that directory. Mapping
app roles or groups to several workspaces would be an addition on top of the
same insert, if one instance ever needs more than one.

What it deliberately does not do:

- **It grants `member`, never `owner`.** A directory answers whether someone
  works here. What they may do once inside is Overseer's question, and a door
  that could mint owners would let anyone the directory admits remove the people
  who built the place.
- **It adds, and never removes.** A membership is not withdrawn when a claim
  changes, because the claim can change for reasons that are not "this person
  left" — a mistyped slug would otherwise evict a team from its own workspace.
- **A slug naming no workspace does not fail the sign-in.** It warns and falls
  through to the personal workspace: landing in the wrong place is recoverable
  with an invite, while a configuration typo that refuses every sign-in is an
  outage.

#### The directory's own workspace

Both settings above need a workspace that already exists and a person to name
it, which is exactly what a fresh instance does not have. `OVERSEER_OIDC_PROVISION_WORKSPACE=1`
removes that step: the first operator through the door creates the directory's
workspace and owns it, and everyone after joins as `member`.

The key is the issuer, held in `workspaces.sso_issuer` under a unique index. It
is the one thing already proven by the time anybody arrives — compared byte for
byte against `iss` before a session exists — so no claim has to be assigned,
owned or typed. The uniqueness also settles the race between two first sign-ins:
one insert wins, and the other reads back what the winner made rather than
failing a sign-in over a collision nobody could have avoided.

**The issuer is the key; the slug stays human.** The workspace is named from
`OVERSEER_OIDC_LABEL` and gets an ordinary slug, because the slug is shown to
people — the workspace UI prints `/{slug}`. Putting a tenant GUID there would
show an operator a UUID where a company name belongs, and would tie a displayed
string to an identifier that must never change.

**The creator owns it.** A workspace whose first member is a plain `member` has
no owner and, since the last owner cannot be demoted, would never get one. The
person who brought it into being by arriving first is the one honest candidate;
this is the single place where SSO hands out more than `member`.

Slack works the same way at this layer: which organisation you enter is decided
by the SSO connection you came through, not by anything in the token. Mapping
groups to workspaces is its second, separate layer — as the claim below is here.

#### When one directory holds several teams

`OVERSEER_OIDC_WORKSPACE_CLAIM=<claim>` names the claim carrying the slugs — one
string, or several in an array. For Entra ID that claim is `roles`: app-role
values are ours to choose, an administrator assigns them, and unlike a groups
claim they arrive as readable strings rather than GUIDs behind an overage
indicator. The fixed slug above stays as the fallback for a token that names
nothing.

What makes this sound is who owns the claim. A role an administrator assigns is
the directory speaking; a profile field its own subject can edit is not, and
reading one would let anybody name any workspace and walk in. The setting is
therefore a statement about this issuer — this instance trusts this claim from
that directory — and rests on the same single-tenant issuer everything else here
does.

**A claim joins; it never creates.** A slug matching no workspace is logged and
skipped, and the operator lands where they would have without it. Creating on
demand would turn a mistyped role into a parallel empty workspace that looks
right and holds nobody — a silent failure instead of a visible one — and would
hand workspace creation to whoever sets claims in the directory.

Slack draws the same line from the other side: it keeps the group-to-workspace
binding in its own settings rather than in the values the directory sends, and
provisions membership over SCIM instead of reading it from a login token. That
difference is worth remembering — a login token can say who arrived, never who
left, which is why none of this is offboarding.

`workspace_members.joined_via` records `creator`, `invitation` or `sso`, so the
member list still answers why each person is in it — the first question of any
access review, and a harder one to answer once a directory can add members with
nobody clicking anything.

**This does not solve offboarding, and should not be mistaken for it.** A
disabled directory account cannot obtain a *new* token, but the one already on
its owner's laptop keeps working until it expires — 90 days by default. Any
instance using SSO for real should shorten `OVERSEER_DEVICE_TOKEN_TTL_MS` to
days; that single value closes more of the gap than the joining mechanism does.

### Microsoft Entra ID

Entra ID is an OIDC provider, so the door above is the whole implementation, and
since 2026-08-20 it needs no switch either. Entra's v2.0 id tokens carry no
`email_verified` at all, and an absent claim is trusted: the instance named this
issuer, no person in a tenant can assert an address of their own choosing, and
the addresses the directory hands out are its own. A provider that does send
`email_verified: false` is still refused — that is the difference between not
speaking and saying no.

**Only a single-tenant issuer.** `https://login.microsoftonline.com/<tenant-id>/v2.0`,
with the directory (tenant) id in the path. The multi-tenant `/common`,
`/organizations` and `/consumers` endpoints stamp the *caller's* tenant into
`iss`, which can never equal a byte-for-byte configured issuer, so they fail
`ISSUER_MISMATCH` by construction. That is the right outcome and not a gap worth
closing: trusting an unverified address from an arbitrary tenant is exactly the
hole the refusal exists to close.

What an app registration must provide, beyond the three OIDC variables:

- a web redirect URI equal to `OVERSEER_OIDC_REDIRECT_URI` — the SPA callback
  page, `${OVERSEER_PUBLIC_URL}/auth/oidc/callback` by default;
- a client secret, since the token request uses `client_secret_basic`;
- an address the door can read — though for Entra this needs nothing. `email` is
  filled from the account's mailbox, so a directory whose accounts have none
  sends it empty or not at all; the door then falls back to `preferred_username`
  and `upn`, which for a work account hold the UPN and are always present under
  scope `profile`.

The address is read from `email`, then `preferred_username`, then `upn` — the
first that holds something shaped like an address. The value is only ever used
as one, since it is what finds and links an account, so a claim carrying a
display name or an opaque id is skipped rather than coerced; a token with
nothing usable anywhere is `400 NO_EMAIL`.

`OVERSEER_OIDC_LABEL` is worth setting here: the issuer host is
`login.microsoftonline.com` for every tenant on earth, which is not the name of
anybody's company.

The tenant id, client id and client secret are not in this repository. They
belong in `.env` on the dev box and in `apps/server/config/deploy.yml` for
production, next to the values [password sign-in](password-auth.md) states
there.

### Failures

`400` for anything the provider or the token said: `BAD_STATE`, `BAD_CODE`,
`BAD_ID_TOKEN`, `NO_ID_TOKEN`, `NO_EMAIL`, `EMAIL_UNVERIFIED`,
`IDENTITY_CONFLICT`, `UNKNOWN_KEY`, `OIDC_DENIED`. `502` for the provider being
unreachable or describing itself wrongly: `PROVIDER_UNREACHABLE`,
`PROVIDER_MALFORMED`, `ISSUER_MISMATCH`. Messages never carry the request that
held the client secret or the token. A native flow receives the same codes
through its deep link, because it is waiting on a redirect rather than a status.

The executable version of all of this is `oidcIdToken.test.ts` (signature,
claims, skew and key rotation against keys the suite generates) and
`oidcRoutes.test.ts`, which drives the whole door against a provider that exists
only inside the test.
