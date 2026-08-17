# Voice input (dictation) — design and configuration

Status (2026-08-12): **the server and the Flutter client are implemented; the
web composer still has no mic.** The provider seam, the pipeline, the route and
its guardrails are in the repo and covered by tests, and the mobile app records
natively and posts to the same endpoint — see [client voice
input](client/voice-input.md) for the shipped client behaviour. What remains is
capture in the browser: nothing in `apps/web/src` calls `getUserMedia` or
`MediaRecorder`. This document is both the design rationale and the
operator-facing configuration reference — see [environment
reference](#environment-reference).

Tracked in Heroboard: OVSR-184 (the server end to end, **done**), OVSR-195 (the
Flutter app, **done**) and OVSR-190 (glossary), deferred as a quality increment
on top of a working pipeline.

The "write your own provider" guide is deliberately not a voice task: it is a
deliverable of publishing Overseer as open source, alongside the README, the
licence and a secrets audit. The env reference and preset table belong to
OVSR-184's definition of done and live in this document.

Two ideas below are recorded decisions rather than planned work, and stay out of
the tasks until something actually calls for them: the `module:` plugin loader
and the `FusedVoiceProvider` hook.

## Goal

Dictate a prompt into the session composer instead of typing it. The operator
taps a mic button, speaks, taps again; within roughly a second the cleaned-up
text is in the textarea, editable before send. This is the Wispr Flow model: a
fast transcriber followed by a fast correction LLM, not raw ASR output.

Overseer is going open source, so the pipeline must be **pluggable**: the first
backend is Groq (Whisper large v3 turbo + a small correction model), but a
self-hoster must be able to point it at OpenAI, a local `whisper.cpp`/
`faster-whisper` server, or a bespoke vendor without forking.

Non-goals for v1: text-to-speech, wake words, voice control of the fleet,
transcription of Peon output, real-time partial results.

## Where transcription runs

| Option | Verdict |
| --- | --- |
| In the browser (Web Speech API, whisper WASM) | No. Quality is poor, Safari/WKWebView support is inconsistent, and a WASM model is a multi-megabyte download on mobile. |
| On the Peon | No. The audio originates on the operator's device, the Peon may be offline, and it adds a tailnet round trip to a latency-critical path. |
| **On Overseer, proxied to a provider** | **Yes.** The API key never reaches a client, web / mobile webview / native share one endpoint, and the provider seam is a single server-side interface. |

## Provider seam

Two independent stages, each pluggable, because the interesting quality knob is
the second one:

```ts
// src/infrastructure/voice/voiceTypes.ts
export interface SpeechToTextProvider {
  readonly id: string;                       // "groq", "openai-compatible", …
  readonly limits: { maxBytes: number; maxDurationMs: number; mediaTypes: string[] };
  isConfigured(): boolean;                   // drives capabilities + config warnings
  transcribe(input: {
    audio: Buffer;
    mediaType: string;                       // exactly what the client recorded
    language?: string;                       // BCP-47 hint, or undefined = auto
    biasPrompt?: string;                     // ≤224 tokens for Whisper-family APIs
    signal: AbortSignal;
  }): Promise<{ text: string; language?: string; model: string }>;
}

export interface TextPolishProvider {
  readonly id: string;
  isConfigured(): boolean;
  polish(input: {
    raw: string;
    glossary?: string[];
    locale?: string;
    draft?: string;                          // text already in the composer
    signal: AbortSignal;
  }): Promise<{ text: string; model: string }>;
}
```

Both interfaces are deliberately one method wide: a third-party adapter is ~40
lines.

## Configuration model

The question is whether to ship vendor-named backends the operator plugs a key
into, or to expose bare transcribe/polish endpoints and let the operator point
them at whatever they run. The answer is neither pole: **the wire contract is
the configuration surface, and vendor names are presets over it.**

Ship exactly one adapter per stage, speaking the OpenAI audio and chat shapes —
multipart `file`/`model`/`prompt` in, JSON out; chat completions for polish.
That contract is spoken by Groq, OpenAI, faster-whisper/`speaches`,
`whisper.cpp`'s server, LocalAI, vLLM, LM Studio and essentially every gateway.
A vendor name then resolves to nothing but a row of data:

The shipped table — `src/infrastructure/voice/voicePresets.ts`:

| `OVERSEER_VOICE` | Base URL | STT model | Polish model |
| --- | --- | --- | --- |
| `groq` | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` | `openai/gpt-oss-120b` |
| `openai` | `https://api.openai.com/v1` | `whisper-1` | `gpt-4o-mini` |
| `local` | `http://127.0.0.1:8000/v1` | `Systran/faster-whisper-large-v3` | — |

A preset is three strings. Every field is individually overridable, so a row
being wrong or stale costs an environment variable, not a fork.

`polishModel: null` means the preset ships no correction model — a bare STT
server has none — so that stage stays unconfigured and the raw transcript is
returned until `OVERSEER_VOICE_POLISH_MODEL` points somewhere.

This is the point of the design: **adding a backend is a one-line data PR, not
an adapter class.** Trivial to review, impossible to break the others.

### Environment reference

The resulting environment, with the common case first:

```
# the entire default configuration
OVERSEER_VOICE=groq
OVERSEER_VOICE_API_KEY=gsk_…

# each stage overrides the preset independently; unset = preset default
OVERSEER_VOICE_STT_BASE_URL=http://whisper.internal:8000/v1
OVERSEER_VOICE_STT_MODEL=Systran/faster-whisper-large-v3
OVERSEER_VOICE_STT_API_KEY=…          # falls back to OVERSEER_VOICE_API_KEY
OVERSEER_VOICE_POLISH_BASE_URL=…
OVERSEER_VOICE_POLISH_MODEL=…
OVERSEER_VOICE_POLISH=off             # raw transcript only; "off" is the only value

# limits and timeouts, shown with their defaults
OVERSEER_VOICE_MAX_DURATION_MS=120000
OVERSEER_VOICE_MIN_DURATION_MS=300    # below this, 200 with empty text — no provider call
OVERSEER_VOICE_MAX_BYTES=4194304
OVERSEER_VOICE_STT_TIMEOUT_MS=20000
OVERSEER_VOICE_POLISH_TIMEOUT_MS=1200
OVERSEER_VOICE_REQUESTS_PER_MINUTE=20
OVERSEER_VOICE_AUDIO_SECONDS_PER_HOUR=…   # rolling per-user audio budget
OVERSEER_VOICE_REQUESTS_PER_DAY=1000      # rolling INSTANCE-wide budget; unset = none
OVERSEER_VOICE_DEBUG_TRANSCRIPTS=1    # log transcript text; off by default, never for production
```

Two variables to run, six to run something exotic, and one shared key because
on Groq one key genuinely covers both stages. Setting a stage's `BASE_URL`
without naming a preset means "OpenAI-compatible endpoint here" — no preset
required, which is the bare-endpoint configuration the question asked about,
available without being the only option.

Note the asymmetry: the polish stage is *only* chat completions, which is
universally OpenAI-shaped, so it needs no vendor knowledge at all. Divergent
wire formats are an STT problem exclusively.

For backends that speak something else entirely — Deepgram, AssemblyAI,
ElevenLabs Scribe, Speechmatics, Azure, or Anthropic's Messages API for polish —
the intended escape hatch is a `module:` path — a dynamic import of one file
implementing the interface. **Not built**: it is deferred until something
actually calls for it, and the interfaces are shaped so it can be added without
disturbing callers. Until then a self-hoster puts their own shim in front of the
exotic backend and configures its URL; the contract is small enough that such a
proxy is ~50 lines. What must never happen is *requiring* a proxy for the
default path.

Providers are constructed per call in `src/infrastructure/voice/index.ts` rather
than memoised at import time — they are two closures over a settings row, so
building them fresh keeps tests and a future config reload from reading a stale
snapshot. Unconfigured or half-configured stages surface through the existing
`configWarnings()` mechanism at boot rather than failing at request time.

Ordered provider fallback is likewise **not built**. One stage resolves to one
backend; a 5xx surfaces as `VOICE_PROVIDER_ERROR` rather than silently retrying
elsewhere.

### Environment reference

Every variable the voice pipeline reads. Resolution order for a stage field is
**per-stage override → preset row → nothing**; the per-stage key falls back to
the shared key.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OVERSEER_VOICE` | unset | Preset name: `groq`, `openai`, `local`. Unset means no preset, and the per-stage base URLs carry the whole configuration. An unrecognised name warns at boot and leaves dictation off. |
| `OVERSEER_VOICE_API_KEY` | unset | The key both stages use. On Groq one key genuinely covers both. |
| `OVERSEER_VOICE_STT_BASE_URL` | preset | OpenAI-compatible root; the adapter posts to `{base}/audio/transcriptions`. |
| `OVERSEER_VOICE_STT_MODEL` | preset | Transcription model id. |
| `OVERSEER_VOICE_STT_API_KEY` | `OVERSEER_VOICE_API_KEY` | Per-stage key, for a split deployment. |
| `OVERSEER_VOICE_POLISH_BASE_URL` | preset | OpenAI-compatible root; the adapter posts to `{base}/chat/completions`. |
| `OVERSEER_VOICE_POLISH_MODEL` | preset | Correction model id. |
| `OVERSEER_VOICE_POLISH_API_KEY` | `OVERSEER_VOICE_API_KEY` | Per-stage key. |
| `OVERSEER_VOICE_POLISH` | unset | `off` returns the raw transcript and suppresses the "no polish model" warning. `off` is the only accepted value; anything else warns. |
| `OVERSEER_VOICE_MAX_DURATION_MS` | `120000` | Client-declared duration ceiling. Over it ⇒ `413 AUDIO_TOO_LARGE`. |
| `OVERSEER_VOICE_MIN_DURATION_MS` | `300` | Below it ⇒ `200` with empty text, and no provider call. |
| `OVERSEER_VOICE_MAX_BYTES` | `4194304` | Raw-body ceiling on the voice router only. Over it ⇒ `413 AUDIO_TOO_LARGE`. |
| `OVERSEER_VOICE_STT_TIMEOUT_MS` | `20000` | Transcription deadline. Exceeded ⇒ `502 VOICE_PROVIDER_ERROR`. |
| `OVERSEER_VOICE_POLISH_TIMEOUT_MS` | `1200` | Correction deadline. Exceeded ⇒ the raw transcript, never an error. |
| `OVERSEER_VOICE_REQUESTS_PER_MINUTE` | `20` | Per-user rolling request cap. |
| `OVERSEER_VOICE_AUDIO_SECONDS_PER_HOUR` | `1800` | Per-user rolling audio budget, charged the greater of the declared duration and a byte estimate so under-declaring buys nothing. |
| `OVERSEER_VOICE_REQUESTS_PER_DAY` | unset | Rolling 24-hour ceiling for the **whole instance**, since the provider budget is shared. Unset means no ceiling, and warns at boot. Set it to your provider tier's daily request limit. |
| `OVERSEER_VOICE_DEBUG_TRANSCRIPTS` | unset | `1` logs transcript text. Dev instances only — the "no transcript text at rest" invariant is worth more than the tuning it would buy. |

**When a stage counts as configured:** it needs a base URL *and* a model, plus
an API key if the base URL is `https`. A plain-`http` endpoint is taken to be a
local or tailnet server and runs keyless, which is what makes the `local` preset
work out of the box. The rule's real job is the common misconfiguration —
`OVERSEER_VOICE=groq` with the key forgotten — which becomes a boot warning
instead of a 502 on the operator's first utterance.

Any unset or half-set stage is reported by `configWarnings()` at startup, and
`GET /api/v1/voice/capabilities` reports `enabled: false` so clients hide the
mic button rather than offering something that cannot work.

### Whose configuration is it

Two different people hide behind "the user", and only one of them belongs in
v1:

- **the operator running an Overseer instance** — configures the environment
  above. This is the right level, and the shape self-hosters expect;
- **an individual user of a shared instance** bringing a personal key — needs
  encrypted per-user secret storage, which does not exist yet (only hashed Peon
  credentials). Deferred, and not required for the open-source story.

## Request path

```
mic → MediaRecorder (opus/mp4) → POST /api/v1/voice/transcriptions
        → operatorAuth + workspace membership + quota
        → STT provider            (~250–400 ms on Groq for a 15 s clip)
        → guardrails
        → polish provider         (~200–400 ms, hard-capped)
        → { text, raw, … }
```

**Raw body, not multipart.** The app has three runtime dependencies and no
multipart parser; adding one for a single route is not worth it. Mount
`express.raw({ type: ["audio/*", "video/mp4"], limit: … })` on the voice router
only, carry the codec in `Content-Type`, and put ids in the query string:

```
POST /api/v1/voice/transcriptions?workspaceId=…&peonId=…&sessionId=…&language=ru
Content-Type: audio/webm;codecs=opus
<binary>

200 { text, raw, polished: true, language, sttModel, polishModel, latencyMs }
```

The global `express.json({ limit: "1mb" })` stays untouched; the voice router
gets its own, larger limit.

### Why HTTP and not a WebSocket

With whole-file sends this is a request/response exchange, which is what HTTP
already is. A socket would cost more than it returns:

- **Fewer round trips, not more.** The web app already holds a warm HTTPS/H2
  connection to the origin, so the upload starts immediately. A socket needs a
  handshake first, and in this codebase an authenticated socket needs a minted
  entry in `websocket_tickets` before that — an extra round trip before a single
  byte of audio moves.
- **Auth is free.** `operatorAuth` already covers both surfaces: an HttpOnly
  cookie plus the CSRF origin check for web, a device bearer token for native.
  No new authentication path, no ticket lifecycle.
- **Standard everything.** Status codes and the stable error codes above, body
  limits via `express.raw({ limit })`, rate-limit middleware, one log line per
  request, `Server-Timing` for the STT/polish split, retries on a plainly
  idempotent POST. Over a socket every one of those is hand-rolled, starting
  with a start/meta/binary/end framing protocol that re-invents `Content-Type`.
- **Streaming the polish back does not require one either.** A chunked response
  body from the POST is readable by `fetch` in every current browser including
  Safari — it is streamed *request* bodies that are unavailable there, not
  streamed responses.

Piggybacking on the session's already-open live socket is the one tempting
alternative — warm, authenticated, no handshake — and it should still be
declined. A ~50 KB binary frame would head-of-line block live transcript events
on the same connection, request/response correlation has to be bolted onto a
channel designed for server→client push, and dictation would only work while a
session page holds a socket open, which excludes the new-session composer.

Revisit only if streamed uploads land: pushing chunks during recording is the
case a socket genuinely fits.

### Caps

Sized for chat-style utterances, not lectures: 120 s and ~4 MB accepted at the
router, well under Groq's 25 MB free-tier ceiling. A 120-second Opus recording
is roughly 400 KB, so the byte cap is headroom for higher-bitrate or AAC
recordings rather than a real constraint. The duration cap is enforced twice —
client-side auto-stop for the UX, server-side for the abuse case.

`GET /api/v1/voice/capabilities` returns `{ enabled, maxDurationMs, maxBytes,
mediaTypes, polish }` so the client can hide the mic button on an instance with
no key configured — the same pattern the composer already uses for
`filesEnabled`.

Stable error codes, branchable by clients: `VOICE_DISABLED` (503),
`AUDIO_TOO_LARGE` (413), `UNSUPPORTED_MEDIA_TYPE` (415), `VOICE_RATE_LIMITED`
(429), `VOICE_PROVIDER_ERROR` (502). Empty speech is a `200` with `text: ""`,
not an error.

`VOICE_RATE_LIMITED` covers three different exhaustions, deliberately behind one
code because the client's correct response to all three is identical — wait for
`Retry-After` and try again: the per-user request rate, the per-user audio
budget, and the instance's daily ceiling. A **429 from the provider itself** maps
here too, carrying the provider's own `Retry-After`. It must never surface as
`VOICE_PROVIDER_ERROR`: that tells a client the instance is broken, and a client
that believes the instance is broken retries immediately, which is the worst
available response to being rate limited.

## Latency: why the pipeline is still two calls

Both stages do run on Groq, on one key — but as two HTTP requests, because Groq
has no fused endpoint: `/audio/transcriptions` returns text, and post-processing
is a separate `/chat/completions` call. The Batch API can carry both request
types, but it is asynchronous and useless for an interactive composer. Verify
against Groq's docs before assuming otherwise; if a combined audio-in chat model
appears, the `FusedVoiceProvider` hook below picks it up without touching
callers.

Letting the client talk to Groq directly, cutting Overseer out of the path, is
not available either: Groq issues no short-lived scoped tokens, so the only
credential a browser could hold is the instance key itself. With open GitHub
sign-up that is a free public ASR service, and it would also give up the
glossary assembly, the quotas and the provider seam.

### Decision: the mobile app proxies through Overseer

Native code is where the "but a real app can hold a key" argument usually
appears. It does not survive contact:

- A key in an IPA/APK is recoverable — `strings` on the bundle, or an
  intercepting proxy on a rooted device. Groq issues no scoped or short-lived
  tokens, so what leaks is the full instance key with full billing rights.
- Overseer is going open source. A direct-to-Groq app means every self-hoster
  must rebuild the mobile client with their own key baked in, or ship a settings
  screen asking each user to paste one. Both destroy the "configure the provider
  in the server environment" story that motivates the seam.
- The pipeline would exist twice — chunking, VAD, glossary, guardrails, the
  polish prompt, fallbacks, error mapping — once in TypeScript and once in Dart.
  Two implementations drift, and every quality fix lands twice.
- The glossary is server-side data (Peon names, project jargon, session
  context). A direct client has to fetch it from us first, so the round trip it
  was avoiding comes back anyway.
- Quotas, abuse control and audit have exactly one chokepoint, and it is not the
  phone.

The latency argument is also weaker than it looks. Overseer sits behind
Cloudflare, so the slow, lossy mobile leg terminates at a nearby edge and the
rest rides a backbone with a warm connection pool to Groq. A phone talking to
`api.groq.com` directly crosses the public internet end-to-end and pays a cold
TLS handshake per utterance. The honest delta is roughly one server-to-server
RTT — and on a bad mobile network the proxy can win outright.

Practically, mobile needs no new auth: native clients already hold revocable
device bearer tokens, so they call `POST /api/v1/voice/transcriptions` exactly
as the web does. If a self-hoster wants per-user keys for privacy reasons, that
is a stored-credential feature on the server, still proxied — one code path.

Where the time actually goes, for a 15-second utterance:

| Segment | Order of magnitude |
| --- | --- |
| client → Overseer (mobile network, ~50 KB) | 50–150 ms |
| TLS handshake to Groq, if not reused | ~2 RTT — **avoidable** |
| Groq Whisper turbo inference (216× realtime) | ~70 ms |
| Overseer ↔ Groq round trips (two calls) | 2 × RTT from the coloc |
| polish generation, small model | 200–400 ms |

The second call costs one extra RTT — real, but far from the dominant term, and
smaller than the polish generation it enables. The optimisations that actually
matter, in order of payoff:

1. **Streamed upload, single inference** (see the transport decision below) —
   get the bytes off the device while the operator is still speaking, then make
   one Groq call at stop. Removes upload from the critical path with no accuracy
   or billing penalty.
2. **Persistent keep-alive to `api.groq.com`.** A warm connection pool removes
   the handshake from both calls; optionally warm it on mic-press so the first
   utterance of a session is not the slow one. Cheap to implement, ~2 RTT saved.
3. **Stream the polish.** Request the correction with SSE and forward tokens to
   the composer as they arrive, so perceived latency is first-token, not
   completion. Requires the response to become a stream rather than one JSON
   body — worth doing in the same pass as the polish stage.

Measure before tuning: the response emits `Server-Timing: stt;dur=…,
polish;dur=…, total;dur=…`, so the split between network and inference is
visible rather than assumed.

### The measured RTT (2026-07-26)

The open question was whether the coloc's distance from Groq's US-centric
endpoints dominates everything else. It does not. Measured with `curl` against
`POST https://api.groq.com/openai/v1/chat/completions` with no key — Groq
answers `401` from the same edge that serves the real endpoint, so this is the
network leg with inference excluded:

| Leg | nid-dev (94.247.128.101) | nid-01, prod coloc (94.247.128.103) |
| --- | --- | --- |
| TCP connect — **one RTT** | **64 ms** | **66 ms** |
| TLS complete, cold | 197 ms | 206 ms |
| Time to first byte, cold | 197–200 ms | 206–234 ms |
| **Time to first byte, warm keep-alive** | **92 ms** | — |

**RTT ≈ 65 ms; a warm round trip costs ~92 ms.** Both hosts are within 3 ms of
each other, so nothing about the coloc is disadvantaged. Budgeting a 15-second
utterance at those numbers: STT ~92 ms network + ~70 ms inference, polish ~92 ms
+ 200–400 ms generation ⇒ **≈ 500–700 ms server-side**, inside the one-second
target with the second call costing ~92 ms of it.

Two consequences. The cold TLS handshake costs ~135 ms — *more than the extra
call* — which makes optimisation 2 the only one worth anything, and it is free:
Node's global `fetch` pools connections, so the adapter gets it without code.
And optimisation 1 (streamed upload) is not justified by these numbers; it stays
where the transport decision below puts it, behind a measurement that has now
been taken and did not ask for it.

### The live end-to-end numbers (2026-07-26)

Measured through the real endpoint on the dev instance with a real recording —
a 15-second spoken-Wikipedia clip re-encoded to `audio/webm;codecs=opus` at
32 kbps mono, which is what a browser `MediaRecorder` produces. 59 KB, close to
the ~45 KB the transport decision predicted.

| Call | STT | Polish | Total |
| --- | --- | --- | --- |
| First after a process start (cold pool) | 577–796 ms | ~190 ms | 765–988 ms |
| **Warm, steady state** | **375 ms** | **190 ms** | **565 ms** |
| Same audio as AAC/m4a (the Flutter path) | 295 ms | 181 ms | 476 ms |
| 2-second utterance | 207 ms | 135 ms | 344 ms |

**565 ms warm, end to end, over HTTP — inside the one-second target**, and the
predicted 500–700 ms band was right. The cold-pool penalty is ~200–400 ms on the
first utterance after a restart and disappears by itself, which is the keep-alive
effect the RTT numbers implied.

Note what the split says: STT is ~375 ms for 15 seconds of audio while Whisper
turbo's inference is ~70 ms, so **the STT leg is mostly upload and queueing, not
inference** — 59 KB up to Groq. That, not the second call, is the largest
remaining term. It is the case streamed upload addresses, and the first real
argument for it; it is still not worth building until dictation has users.

Quality, unedited: `"but we'd prefer that you start with one of these bullet one
articles soon to be featured on the main page…"` became `"But we'd prefer that
you start with one of these bullet points: one, articles soon to be featured on
the main page; two, featured articles marked with a star; three, requested
spoken articles."`

Three defects surfaced here that fakes could not have caught, all fixed: `json`
had to become `verbose_json` or `language` was permanently null; the correction
model announced itself with `"Here's the corrected text:"` on short utterances,
which is short enough to slip under the growth ratio; and a swallowed polish
failure left no diagnosable trace, only a counter.

### Russian on real audio, and why the polish model is not an 8B

Tested with synthesized Russian dictation of the kind actually spoken here —
plain Russian, Russian thick with fillers and a stutter, and Russian carrying
English project nouns. `language` comes back `Russian`, nothing is translated,
and latency matches English (546–857 ms).

The correction stage is where this got interesting. With the originally-chosen
`llama-3.1-8b-instant` the guardrails held, but the model **silently rewrote
things no guardrail can see**:

- it changed grammatical register — `задеплой … проверь` (informal, ты) came
  back as `задеплите … проверьте` (formal вы). The operator's own voice, edited;
- it restructured clauses and invented words — `посмотри логи в Камал, прокси и
  проверь` became `посмотри логи в Камал, проверь прокси и убедись`;
- in English it added a word that was never said (`came back healthy` →
  `came back up healthy`).

None of these trip the length ratio, because none of them change the length
much. Tightening the system prompt was tried first and **changed nothing** — an
8B model at temperature 0 does not follow negative constraints of this kind.

`llama-3.3-70b-versatile` fixes all three, is no slower in practice (184–367 ms
against 149–523 ms), and additionally makes corrections the 8B missed — it
repaired `на прот` → `на прод`. So the default polish model changed, and the
whole fix was **one string in the preset table**, which is the configuration
design paying for itself. `OVERSEER_VOICE_POLISH_MODEL=llama-3.1-8b-instant`
restored the cheaper model for anyone who wanted it.

Two other models were rejected on the same evidence, and both were caught by
existing guardrails rather than by inspection: `qwen/qwen3.6-27b` emits a
`<think>` monologue (the growth ratio discards it and returns raw), and
`openai/gpt-oss-20b` returned an empty completion for one case (the
`polish-empty` guardrail returns raw).

### 2026-08-16: Groq retired both Llama models, and the preset moved to GPT-OSS 120B

Groq decommissioned `llama-3.3-70b-versatile` (and the `llama-3.1-8b-instant`
fallback named above) on 2026-08-16; neither is in `GET /v1/models` any more.
Production runs `OVERSEER_VOICE=groq` with no `OVERSEER_VOICE_POLISH_MODEL`
override, so from that date until the preset changed every dictation took the
`polish-error` path and returned the raw transcript. **Nothing broke visibly,
which is the point of the swallow-and-degrade design and also the reason this
went unnoticed for a day** — a decommissioned polish model looks exactly like a
quality regression, not an outage.

The preset now reads `openai/gpt-oss-120b`, chosen on the same evidence as
before. Re-running the failure classes above through the real provider: the
informal ты survives (`задеплой … проверь` comes back as `Задеплой … проверь`),
`на прот` → `на прод` is still repaired, mixed RU/EN is left alone, a transcript
that reads like a question (`what's the capital of France`) is punctuated rather
than answered, and all seven probes cleared the ratio guardrail at 413–969 ms —
slower than the 70B's 184–367 ms, still well inside the budget. The reasoning
tokens stay in Groq's separate `reasoning` field, so nothing leaks into
`content`. `qwen/qwen3.6-27b`, the other vendor-recommended replacement, was
re-checked and still emits `<think>`, so it is still rejected.

The whole fix was again one string in the preset table plus the tests pinning
it. Worth keeping in mind: **a preset row is a dated fact about someone else's
catalog.** The failure mode is silent, so the next vendor decommission notice is
a reason to re-check this row rather than assume it still resolves.

**What is still wrong, and it is not a polish problem:** project nouns are
mangled at the STT stage. `Kanat` → `коннет`, `Overseer` → `Аверсир`, `healthz`
→ `Хелтас`, `kamal-proxy` → `Камал, прокси`. The polish stage cannot repair a
name it has never been told about, and 70B guessing harder would be worse, not
better.

### The glossary fix, measured before it is built

The seam already carries `biasPrompt` and `glossary`; OVSR-190's job is only to
populate them. Running the 2×2 by hand against the same audio settles what each
stage is worth, and confirms the design's claim that they do different jobs:

| Configuration | Result |
| --- | --- |
| neither (today) | `Задеплай коннет … через Камал … логи в Камал, прокси … Аверсир … Хелтас` |
| STT bias only | `… через Kamal … логи в Kamal, прокси … Averseer … Heltos` |
| polish glossary only | `… через Камал … Камал-прокси … Overseer … healthz` |
| both | `… через Kamal … Kamal-прокси … Overseer … healthz` |

**Four of the five recover, and neither stage alone is sufficient.** The STT
bias prompt restores *script* — Cyrillic transliteration back to Latin — but not
spelling. The polish glossary restores *identity*, because the model sees the
whole term list next to the sentence, but leaves script alone. They compose.

`Kanat` → `коннет` survives even with both, and the reason is instructive:
`коннет` is a near-homophone of `коннект` ("connect"), a real word, so the model
prefers the common noun over the proper one. That is the case proximity ranking
exists for — the session's own Peon deserves a stronger position than a place in
a flat list of fifty terms.

### Transport: whole file first, streamed upload as the measured upgrade

Three options, and the middle one is the answer once measurement justifies it.

**Whole file after stop — v1.** A 15-second Opus clip is ~45 KB: roughly
50–150 ms on LTE, more on a weak signal. Simple, identical in web and native,
trivially retryable on the flaky mobile networks that actually matter, and the
whole request stays idempotent. Start here.

**Streamed upload, single inference — the upgrade.** Push `MediaRecorder`
chunks to Overseer while recording, buffer them server-side, and fire one Groq
call at stop with the assembled file. At stop only the last ~200 ms of audio is
still in flight, so upload leaves the critical path — while the audio Groq sees
is byte-identical to the whole-file case. No accuracy loss, no extra billing, no
multi-call orchestration. Use the existing WebSocket infrastructure rather than
streamed HTTP request bodies: `fetch` with a `ReadableStream` body needs HTTP/2
plus `duplex: "half"` and is not reliably available in Safari, which is exactly
the browser the iOS webview runs. Native clients could stream over HTTP fine,
but one transport for both surfaces beats two.

**Segmented pre-transcription — only for long-form.** Transcribing completed
segments during recording sounds like the bigger win, and for 60-second-plus
dictation it is. For a normal utterance it is a bad trade:

- Whisper turbo runs at ~216× realtime, so 15 seconds of audio is ~70 ms of
  inference. There is almost nothing to hide.
- Groq bills a 10-second minimum per request, so six segments of a 30-second
  utterance bill 60 seconds instead of 30. Cheap in absolute terms, but it is
  pure waste.
- Accuracy drops at segment boundaries; mitigating it needs overlapping windows
  and de-duplication of the overlap in the joined text.
- `MediaRecorder` chunks are **not independently decodable**. Only the first
  carries the container header, in both WebM/Opus and fragmented MP4. Streaming
  and concatenating in order yields a valid file, but sending chunk N to Groq on
  its own does not — each segment needs the init header prepended or a
  re-encode.

That last point is the practical dividing line: assemble-then-transcribe is a
buffer, segment-and-transcribe-independently is a media-container project.

Whichever transport is in use, the server buffers in memory only, bounded by
`maxBytes`, and never writes audio to disk.

### The fused-provider hook

To keep the door open without weakening the seam, the pipeline probes for an
optional third capability and composes the two stages only when it is absent:

```ts
export interface FusedVoiceProvider {
  readonly id: string;
  transcribeAndPolish?(input: TranscribeInput & PolishOptions): Promise<VoiceResult>;
}
```

A backend that genuinely does audio-in → clean-text-out in one shot (a future
Groq model, a local pipeline, a vendor with a combined endpoint) implements it
and the pipeline drops to a single call. Nothing above the seam changes.

## The correction pass

This stage is what separates dictation that feels good from dictation that
feels like 2015. Its job is narrow and must be enforced as such.

System prompt intent: fix punctuation, casing and obvious ASR errors; drop
filler words and false starts; apply the glossary; **preserve the spoken
language** (ru/en mixing is normal here — never translate); do not answer,
summarise, expand or comment on the content; output only the corrected text.

Guardrails, because a correction model will occasionally decide to answer the
prompt instead of cleaning it:

- length ratio: if the polished text is longer than ~1.6× or shorter than ~0.5×
  the raw text, discard it and return the raw transcript;
- strip wrapping quotes and code fences;
- hard timeout (~1200 ms) on the polish call — on timeout, return raw. Polish
  failure is **never** fatal;
- the response always carries `raw` alongside `text`, so the UI can fall back
  and so quality regressions are diagnosable without logging audio.

## Context injection

The second quality lever, and the reason it is worth owning this pipeline
rather than embedding a vendor widget. Overseer knows things a generic
transcriber does not: Peon names (Kanat, Marat, Nova, Thor), project names,
repo jargon (Kamal, Tailscale, kamal-proxy, Postgres), the current session's
prompt preview, and the draft already in the composer.

The client sends only ids; the server assembles the glossary from data the
caller is already authorised to see.

**The two stages get different glossaries, and the small one is not the
important one.** Whisper's `prompt` field caps at 224 tokens — realistically
50–80 terms, fewer under mixed ru/en, since invented proper nouns and Cyrillic
both tokenise badly. The full vocabulary does not fit and should not try to:

- **STT bias set — small and curated.** Only terms Whisper gets *phonetically*
  wrong: invented names (Peon, Overseer, Heroboard, kamal-proxy) and the
  people/Peon names in play. Words already well represented in training data —
  Postgres, nginx, Cloudflare — need no biasing and waste budget. Rank by
  proximity: the session's Peon and project first, then the workspace, then
  general jargon, and truncate on a real token count rather than an estimate.
- **Polish glossary — the full dictionary.** The correction model has an
  ordinary context window and no 224-token limit, so hundreds of terms and
  project abbreviations go here. This is where "канат" becomes "Kanat", because
  the model sees both the whole term list and the sentence around it.

The small bias set is a better design, not merely a forced one: Whisper's prompt
guides style and context rather than acting as a substitution dictionary, and an
overstuffed prompt can leak into the transcript — a documented failure mode.

## Client capture

- Feature-detect with `MediaRecorder.isTypeSupported`: Chrome/Firefox/Android
  produce `audio/webm;codecs=opus`, Safari and iOS produce `audio/mp4`. Send
  whatever was produced and let the server forward the media type — do not
  transcode in the browser.
- Constraints: mono, `echoCancellation`/`noiseSuppression`/`autoGainControl` on,
  ~24–32 kbps. A 15-second clip is ~50 KB, so upload latency is negligible and
  single-shot upload after stop is fine for v1.
- Cap duration client-side (~120 s) with auto-stop, plus a byte cap server-side.
- Toggle to record (tap start / tap stop), `Esc` cancels and discards. A desktop
  keyboard shortcut is a phase-2 nicety.
- Insert at the caret, never clobber an existing draft. `Composer` is already a
  controlled component; it needs an `onInsertText` affordance and a mic slot in
  the toolbar next to the attach button.
- Handle the three permission states explicitly: never asked, granted, denied
  (denied needs a "enable the microphone in browser settings" hint, since a
  second `getUserMedia` call will not re-prompt).

### Flutter capture

The mobile app is Flutter, not a webview, so `getUserMedia` and WKWebView
capture permissions are not involved at all. It records natively and posts to
the same endpoint the web uses. The webview is only the login surface — see
[mobile webview login](mobile-webview-login.md).

- **Recorder:** the `record` package. Encode **AAC-LC in an m4a container on
  both platforms** rather than matching the web's Opus: iOS has no native Opus
  encoder, and Groq accepts `m4a`/`mp4` anyway. One format means one server
  path. Send `Content-Type: audio/mp4`. Mono, 16 kHz, ~32 kbps.
- **Permissions:** `NSMicrophoneUsageDescription` in `Info.plist` and
  `RECORD_AUDIO` in the Android manifest with a runtime request. Handle the
  permanently-denied case with a deep link into system settings, since a second
  request will not re-prompt.
- **Audio session:** set the iOS category for recording and restore it after, so
  dictation does not leave media playback broken. Handle interruptions (an
  incoming call, Siri) by stopping and discarding the take.
- **Lifecycle:** backgrounding stops and discards the recording. No background
  recording, which also avoids needing the background-audio entitlement.
- **Amplitude:** `onAmplitudeChanged` drives both the level meter and the
  client-side silence check that suppresses the Whisper hallucination case.
- **Transport:** the existing API client with its device bearer token — no new
  auth path. Bytes in the body, ~20 s timeout, one retry on a network error.

## Abuse, privacy, cost

- Sign-up is open GitHub OAuth, so an authenticated user is not a trusted user.
  The voice route must be gated on **workspace membership**, not merely
  authentication, and rate-limited per user (e.g. 20 requests/min and a rolling
  audio-minutes-per-hour cap). Otherwise the instance key is a free ASR service.
- **Per-user limits do not protect a shared provider budget**, and the two are
  easily confused. 20 requests/minute is 1200 an hour for a single user, against
  a provider tier whose *daily* ceiling may be smaller than that — so one
  entirely legitimate user can spend the fleet's whole day before lunch.
  `OVERSEER_VOICE_REQUESTS_PER_DAY` is the instance-wide ledger that stops it.
  It is unset by default and warns at boot, because only the operator knows
  their tier and silently capping a paid account at a guessed number would be
  worse than the warning.
- Audio is never persisted. Logs carry duration, bytes, provider, model and
  latency — never the transcript text, except behind an explicit debug flag.
- Quality is therefore measured without recording speech. The text-free signals
  are the guardrail trip rate, the empty-transcript rate, the detected language,
  latency, and edit-after-dictation — characters changed in the composer within
  ~30 s of an insert, which says how bad quality is without saying what was
  said. To see *what* is wrong, run the debug flag on the dev instance against
  your own dictation. Fleet-wide transcript collection would require explicit
  opt-in, text only, and short retention; "no transcript text at rest" is worth
  more as an invariant than the tuning it would buy, especially for a tool that
  ships to other people's servers.
- Dictation ships audio and workspace jargon to a third party. It stays disabled
  until a key is configured, and the docs must say plainly what leaves the box.
- Whisper-family models hallucinate confident phrases on silence ("Thank you.",
  Russian subtitle credits). Mitigate with a client-side RMS/VAD check that
  refuses to send near-silent clips, a minimum duration (~300 ms), and a small
  server-side blocklist for very short results.
- Keys live in the environment for v1 — the shape self-hosters expect.
  Per-workspace BYO keys need an encrypted secret store, which does not exist
  yet (only hashed Peon credentials); defer to a later phase.

## Module layout

Following the repo's architecture doc (`docs/architecture.md`) — external
systems belong in `infrastructure`, product rules in a module:

What shipped:

```
src/infrastructure/voice/
  index.ts                       provider resolution, capabilities, one call to run the pipeline
  voiceTypes.ts                  the two provider interfaces + VoiceProviderError
  voiceConfig.ts                 env → settings; pure, so config.ts can own the wiring without a cycle
  voicePresets.ts                the vendor data rows
  voiceMedia.ts                  accepted containers and the filename each provider needs
  voicePipeline.ts               stt → guardrails → polish orchestration
  providers/openaiCompatible.ts  the single adapter, both stages
src/modules/voice/
  voiceAccess.ts                 workspace membership + quota admission
  voiceQuota.ts                  the rolling per-user request and audio budgets
src/routes/voice.ts              raw-body route + capabilities
```

Two deviations from the sketch above, both deliberate. There is no
`providers/groq.ts` or `providers/anthropicPolish.ts`: a vendor is a data row,
so a vendor-named adapter file would contradict the design it implements.
And `voiceService.ts` split into `voiceAccess`/`voiceQuota`, since with the
glossary deferred to OVSR-190 the file would have been a `Service` suffix over
two unrelated concerns — which the architecture doc asks us not to do.

The client capture files (`apps/web/src/voice/recorder.ts`, `useDictation.ts`) are
not built; they belong to the composer work, not the endpoint.

Tests follow the existing `node --test` style and touch no network. Fake
providers exercise the pipeline (both ratio directions, the polish timeout
fallback including a provider that ignores its abort signal, the silence
blocklist, wrapper stripping); a stubbed `fetch` exercises the adapter's wire
shape and error mapping; and `src/routes/voiceRoutes.test.ts` drives the real server
with a `pg-mem` database for auth, membership, the caps, the rate limit and the
stable error codes.

## Phasing

1. ~~**Spike**~~ — folded into v1. The one question it existed to answer was
   the RTT, which was measured directly (65 ms) without needing a spike branch.
2. **v1 — done (OVSR-184).** Provider seam, `openai-compatible` adapter, polish
   stage with guardrails, capabilities endpoint, quotas, tests, env reference.
   Verified live against Groq at 565 ms warm end to end; the dev instance is
   configured and serving dictation.
3. **v1.5** — the Flutter recorder (OVSR-195) is done. Still open:
   glossary/context assembly (OVSR-190), ru/en handling, the web mic button,
   a keyboard shortcut and the cancel/retry UX.
4. **Later** — streaming partials over the existing WebSocket infrastructure,
   per-workspace BYO keys, additional bundled vendors.

## Open questions

- Does dictation belong only in the session composer, or also in the new-session
  and project-note surfaces? The seam supports all three; v1 scope is the
  composer.
- Which presets ship in v1 beyond `groq`, `openai` and `local`? Each is a data
  row, so the bar is "someone will actually run it", not engineering cost.
