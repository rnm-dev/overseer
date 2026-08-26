# Selected-text replies

The canonical machine-readable contract is
[`selected-text-replies-v1`](protocol/selected-text-replies-v1/schema.json),
with executable examples in
[`fixtures.json`](protocol/selected-text-replies-v1/fixtures.json). It is the
one contract shared by Peon, Overseer, web and Flutter.

The contract adds an optional durable reply relationship to Peon follow-ups and
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

V1 source rules are deliberately narrow: the selection must be contained in one
replyable event; `eventId` is provenance and `selectedText` is the durable
display authority. Source event deletion or unavailable history never deletes
the retained quote: clients render it with a source-unavailable state. System,
tool, result, preview, stderr and warning events are not replyable.

## Interaction behavior

Selecting transcript text is neutral on every client: selection changes and mouse-up do not set composer reply state or clear the selection. A desktop web or desktop Flutter operator explicitly chooses `Reply` from the platform-appropriate selection/context menu. The action is offered only for a valid, non-empty selection whose two ends are contained in one replyable transcript event and only when `selected-text-replies-v1` is advertised.

On web desktop, the custom contextual affordance keeps `Copy`, and preserves link actions when the selection is over a link. It is keyboard and screen-reader accessible and closes on Escape, outside interaction, scrolling, selection changes, route/session changes, and after an action. Invalid or cross-event selections do not intercept the browser menu. Touch web keeps the browser's native selection interaction; there is no portable way to add a Reply item to that native menu, so selection never triggers a reply.

Flutter uses the adaptive native selection toolbar and retains all standard platform actions, adding `Reply` only for a valid selection and non-null capability-gated callback. Invoking that item sets the existing composer `replyTo` state; the selection callback itself remains side-effect free. The existing send, queue, retry, clear, source-navigation and durable-rendering rules are unchanged.

The route-level rules are also explicit. `replyTo` is optional on follow-up and
queue creation; queue edit omission preserves the existing value and `null`
clears it. A legacy Peon keeps ordinary follow-ups working, while a client must
not offer the reply action unless `selected-text-replies-v1` is advertised.
Changing the selected event or text changes the logical request identity for
idempotency; the quote is never included in logs, analytics dimensions or
diagnostic summaries.

Both source-checkout protocol documents record the concrete route shapes and
stable error codes; this page owns the cross-artifact behavior.
