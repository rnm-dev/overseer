# Voice input

The session composer supports native dictation on Android and iOS. The mic
affordance is capability-driven: it remains absent on unsupported platforms,
older Overseer instances without the capability route, and instances that
return `enabled: false`.

## Server contract

The connection-scoped repository caches:

```text
GET /api/v1/voice/capabilities
```

The response supplies `enabled`, `maxDurationMs`, `maxBytes`, `mediaTypes`, and
`polish`. The client caps recording at the lower of the advertised duration and
120 seconds.

After a valid take, the client sends:

```text
POST /api/v1/voice/transcriptions
Content-Type: audio/mp4

?workspaceId=<id>&peonId=<id>&sessionId=<id>
<raw m4a bytes>
```

The shared authenticated Dio client supplies the device bearer token. The
request has 20-second send and receive timeouts and retries once only for a
connection or timeout failure. The POST is idempotent. It is never multipart
and never streamed progressively.

Stable server errors are mapped to concise alert-style bottom sheets:

- `VOICE_DISABLED`: disable and hide the mic;
- `AUDIO_TOO_LARGE`: ask for a shorter take;
- `UNSUPPORTED_MEDIA_TYPE`: report the incompatible instance;
- `VOICE_RATE_LIMITED`: ask the operator to wait;
- `VOICE_PROVIDER_ERROR`: report that transcription failed.

A successful response with empty `text` is shown as “Nothing was said.”

## Native capture

`record` writes AAC-LC in an m4a container on both mobile platforms:

- mono;
- 16 kHz requested sample rate;
- 32 kbps requested bit rate;
- whole-file temporary output, deleted after stop;
- amplitude sampled every 100 milliseconds.

Android declares `RECORD_AUDIO`; iOS declares
`NSMicrophoneUsageDescription`. Runtime permission is requested only from an
operator action. A permanently denied or restricted permission renders an
explicit **Open settings** action in an alert-style bottom sheet instead of
attempting another silent request. Voice errors never add or remove rows inside
the composer, so its geometry remains stable.

Recording temporarily configures the shared audio session for measured
speech/voice communication. Stop, cancel, interruption, disposal, and failure
all deactivate it and restore the previous configuration (or the music default
when no configuration existed).

Incoming audio interruptions and any app lifecycle transition away from
`resumed` cancel the recording and discard the temporary file. Recording never
continues in the background.

## Composer behavior and guards

Tap the mic to start and tap the stop icon to transcribe. Recording shows
elapsed time, a live five-segment level meter, a clear cancel action, and a
visible remaining-seconds countdown for the final 15 seconds. Start and stop
provide haptic feedback.

The draft stays editable while transcription is in flight. Returned text
replaces the current selection or inserts at the caret with boundary spacing;
it never replaces the whole draft implicitly.

Before upload, the client discards:

- takes shorter than 300 milliseconds;
- empty recorder output;
- takes whose amplitude samples have RMS below `0.008`;
- files larger than the server-advertised `maxBytes`.

## Verification

Automated tests cover capability caching and hiding, raw request shape, the
single network retry, permission recovery, silence rejection, composer states,
and caret insertion.

QA requires real Android and iOS hardware. Simulators are not valid evidence
for:

1. first denial, permanent denial, and recovery through system settings;
2. incoming-call/Siri interruption and backgrounding;
3. poor-network timeout/retry with no stuck transcribing state;
4. Russian, English, and mixed Russian/English output without translation;
5. a voice-disabled Overseer;
6. stop-to-insertion latency compared with the Overseer-to-provider RTT.

The end-to-end cases depend on the server voice route tracked by OVSR-184.
