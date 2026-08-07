# Selected-text replies

OVSR-369 adds an optional durable reply relationship to Peon follow-ups and
queued messages:

```json
{ "replyTo": { "eventId": "transcript-event-id", "selectedText": "exact selected text" } }
```

Peon validates that the source event is in the same session and is a
text-bearing `assistant` or `user_message`. It writes the object unchanged to
the authoritative resulting `user_message`; clients must not persist source
offsets or create transcript rows themselves. Queue edits preserve metadata
when omitted and clear it only with `replyTo: null`.

The selected text is durable display context, preserving whitespace and Unicode
exactly. It is bounded to 8,192 Unicode code points and 16 KiB UTF-8. Peon
constructs a provider-neutral quoted-context envelope for Codex app-server and
Claude Code, while keeping the operator's original prompt as the transcript
event's `text`. Provider-native reply/thread primitives are not used.

Legacy records without `replyTo` remain readable. Queue persistence, restart
recovery, pagination/live publication and branches retain ordinary transcript
event fields, so this metadata follows the same authority and lifecycle.

The Peon source-checkout protocol records the concrete route shapes, stable
error codes and source eligibility.
