# Configuration

Every setting is an environment variable, resolved once at boot in
`apps/server/src/infrastructure/config/index.ts` and the three resolvers beside
it (`auth/authConfig.ts`, `voice/voiceConfig.ts`, `push/pushConfig.ts`). Those
resolvers are pure — the environment arrives as an argument — so what an
instance has is decided in one place and tested without touching
`process.env`.

The annotated template a deployment starts from is `deploy/docker-compose.yml`
— a complete install, app and database, with every setting written inline and
the ones to edit marked. It is deliberately not paired with a `.env`: a value
interpolated from a second file is a value you have to go and look up, and the
two drift. This page is the reference behind that template.

The dev stack at the repository root is a different thing and keeps its own
`.env.overseer-dev`; see [the dev box](dev-box.md).

## What is a variable and what is not

A variable exists when a deployment genuinely decides the value: which
database, which origin, which sign-in doors, which provider, and the ceilings
that cost money. Values that are merely tuned — how short an utterance counts
as silence, how long a transcription may take — are constants next to the code
that uses them. The distinction matters because the environment is the surface
an operator has to read before they can run this at all; anything in it that
nobody ever sets makes the real settings harder to find.

Two variables are required. Everything else has a default that produces a
working instance.

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 16 connection string. Schema migrations self-apply on boot under an advisory lock, so an empty database is a valid start. |
| `OVERSEER_PUBLIC_URL` | This instance's public origin, as a browser reaches it. |

`OVERSEER_PUBLIC_URL` has a development fallback of `https://overseer.rnm.dev`
— our own origin. Under `NODE_ENV=production` an unset value stops the boot
instead: sign-in callbacks, peon enrollment and host validation all derive from
it, so inheriting it would point another deployment's own people at our host.
That refusal and the missing-`DATABASE_URL` refusal are the only two; see
`configErrors()`.

Requests whose `Host` does not match the public origin are answered
`421 MISDIRECTED_REQUEST`. That is host validation working.

## Sign-in

Each door is its settings or `null`, resolved in `resolveAuthConfig`. Half a
door — an id without its secret, an OIDC issuer without a client — is `null`
with a warning rather than a method that dead-ends at the exchange. An instance
with no door at all boots and says nobody can log in.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OVERSEER_PASSWORD_AUTH` | off | `1` opens email + password sign-in and registration. See [email and password sign-in](password-auth.md). |
| `OVERSEER_GITHUB_CLIENT_ID` / `_CLIENT_SECRET` | — | GitHub OAuth app. |
| `OVERSEER_GITHUB_SCOPE` | `read:user user:email` | |
| `OVERSEER_GITHUB_REDIRECT_URI` | `<public-url>/auth/github/callback` | Must match what the OAuth app has registered. |
| `OVERSEER_GITHUB_NATIVE_CALLBACKS` | `overseer://oauth/github` | Deep links a native client may be returned to, allowlisted so a request cannot name its own. |
| `OVERSEER_OIDC_ISSUER` | — | Provider origin, https only. Endpoints come from its discovery document. |
| `OVERSEER_OIDC_CLIENT_ID` / `_CLIENT_SECRET` | — | |
| `OVERSEER_OIDC_SCOPE` | `openid profile email` | `openid` is added if omitted. |
| `OVERSEER_OIDC_REDIRECT_URI` | `<public-url>/auth/oidc/callback` | |
| `OVERSEER_OIDC_NATIVE_CALLBACKS` | `overseer://oauth/oidc` | |
| `OVERSEER_OIDC_LABEL` | the issuer's host | What the sign-in button says. |
| `OVERSEER_DEVICE_TOKEN_TTL_MS` | 90 days | Lifetime of an issued device token, whichever door issued it. |

The full picture, including which door a returning operator lands on, is
[sign-in methods](sign-in-methods.md).

## Network, peons and previews

| Variable | Default | Meaning |
| --- | --- | --- |
| `OVERSEER_PORT` | `5000` | |
| `OVERSEER_HOST` | `0.0.0.0` | Every supported deployment is a container behind a reverse proxy, where a loopback bind reaches nothing. Publishing the port is the proxy's decision. |
| `OVERSEER_PEON_CALLBACK_URL` | `OVERSEER_PUBLIC_URL` | Where a peon is told to phone home. Set it only when peons arrive by a different name than browsers do — a tailnet address against a public domain. |
| `OVERSEER_TRUSTED_PROXIES` | empty | Comma-separated addresses or CIDRs allowed to supply `X-Forwarded-For`. Empty means client addresses collapse to the socket peer. The reasoning, and the production finding, are in [trusted client IPs](proxy-trust.md). |
| `OVERSEER_RECONCILE_INTERVAL_MS` | `30000` | How often the session index re-pulls each online peon. |
| `OVERSEER_PREVIEW_DOMAIN` | `preview.overseer.rnm.dev` | Wildcard domain for isolated HTML artifact previews. Needs its own wildcard DNS and a certificate covering the nested host — see the known limitation in the [deploy runbook](deploy-runbook.md). |
| `OVERSEER_PREVIEW_TOKEN_TTL_MS` | `600000` | Clamped to 30 s–1 h. |

Peon enrollment is not opt-in. It follows the public origin unless a
deployment says otherwise, because an instance an operator can reach is an
instance a peon can reach.

## Voice dictation

Off until a provider resolves; clients read `/api/v1/voice/capabilities` and
hide the microphone on an instance without one. A preset plus a key is the
whole configuration. See [voice input](voice-input.md).

| Variable | Default | Meaning |
| --- | --- | --- |
| `OVERSEER_VOICE` | — | A preset name, e.g. `groq`, or `off`. |
| `OVERSEER_VOICE_API_KEY` | — | Shared by both stages. |
| `OVERSEER_VOICE_STT_BASE_URL` / `_MODEL` / `_API_KEY` | from the preset | Per-stage override. A base URL with no preset means an OpenAI-compatible endpoint lives there; a plain-http one is treated as a trusted local server and needs no key. |
| `OVERSEER_VOICE_POLISH_BASE_URL` / `_MODEL` / `_API_KEY` | from the preset | The transcript-correction stage. |
| `OVERSEER_VOICE_POLISH` | — | Only `off` is understood: a deliberate raw transcript. |
| `OVERSEER_VOICE_REQUESTS_PER_DAY` | unset — no ceiling | The instance's total. Warned about at boot, because the per-user limits below are per user: 20 a minute is 1200 an hour for one person. |
| `OVERSEER_VOICE_REQUESTS_PER_MINUTE` | `20` | Per user. |
| `OVERSEER_VOICE_AUDIO_SECONDS_PER_HOUR` | `1800` | Per user. |
| `OVERSEER_VOICE_MAX_DURATION_MS` | `120000` | Raise it for longer dictation. |

The shape of an utterance is fixed in the `SHAPE` constant in `voiceConfig.ts`
— minimum duration 300 ms, 4 MB of audio, a 20 s transcription budget and a
1.2 s polish budget — and ignores the environment. Transcripts are never
logged and audio is never persisted, with no switch to change that.

## Push notifications

| Variable | Default | Meaning |
| --- | --- | --- |
| `OVERSEER_PUSH_FCM_CREDENTIALS` | — | A Firebase service account as raw JSON, base64 of it, or a path — told apart by the first character. Expo delivery needs no credential; this only adds the direct FCM path. |

See [push notifications](push-notifications.md).

## Rollout gates, not settings

`OVERSEER_REVERSE_ROUTING`, `OVERSEER_REVERSE_CAPABILITY_ROLLOUT`,
`OVERSEER_REVERSE_ALLOWLIST_*` and `OVERSEER_LEGACY_CALLBACK_FALLBACK` belong
to the reverse-control cutover and are governed by
[rollout controls](reverse-rollout.md). Their defaults are the tested path; a
deployment should not set them.

## Warnings and errors at boot

`configErrors()` stops the boot. `configWarnings()` prints and continues,
because a reduced instance is a valid one: no voice provider, no FCM
credential, no forwarded-address trust. A warning naming a half-configured
value is the resolver reporting what it found, not a failure.
