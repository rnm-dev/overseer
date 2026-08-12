# Composer ghost convergence

Peon is the only transcript authority. Web and Flutter render a single
composer-owned ghost after the transcript while an immediately dispatched turn
has not appeared in authoritative history. Neither client inserts a transcript
row, and neither correlates a transcript event by text, attachments, author, or
timing.

## Retirement contract

A ghost captures the complete cached user-message count before dispatch. It is
visible while the current complete cached count is no greater than that
baseline, and retires on the first greater count. It also retires after 60
seconds, on an explicit permanent refusal, when its session surface is disposed,
or when the authoritative queue exposes the same client command after a
start-now transition. Queue submissions made through the ordinary running-turn
path never create a ghost because the authoritative queue widget is already the
pending representation.

Steering a queued item is the exception, because that row stops being the
pending representation the moment it is steered. In the web client the click
creates the same single ghost from the queued prompt and attachments and hides
the row from the local queue list at once. Nothing else about the contract
changes — the ghost still retires on transcript growth rather than on the 2xx —
and a steer that was not accepted un-hides its row and drops its own ghost
unless a later send already owns the slot. The Flutter client still leaves the
queued row in place until Peon pops it.

Hiding that row must outlast the request. A steer is answered as soon as the
redirect is issued, and a provider without a native in-flight steer redirects by
interrupting the run, so the item stays in Peon's authoritative queue until the
replacement run starts — seconds later on Claude Code. A client that trusts the
snapshot following its own request therefore shows the row again beside the
message it has already rendered. The web client hides a steered id until the
authoritative list itself no longer contains it, and expires the id after the
same 60 seconds that bound the ghost, so a steer that never lands cannot hide a
still-queued message forever.

The count must cover the complete local cache, not only the bounded visible
page. Newest-page REST reconciliation and replayed tail frames are deduplicated
by authoritative `eventId` before they affect that count or render rows.

HTTP completion and transcript publication may arrive in either order. A 2xx
does not retire the ghost; authoritative transcript growth does. A network
failure, HTTP 408/425/429, or 5xx is ambiguous and retains the unchanged
`Peon-Request-Id` for idempotent retry. An explicit permanent 4xx removes the
ghost, restores the draft, and clears the identity so a corrected retry is a new
request.

An attachment upload or local validation failure before the follow-up request
is attempted also removes the ghost and restores the draft because the turn
cannot have been accepted. Its unchanged request identity may be kept to make a
repeated upload path idempotent.

## Concurrent-send bound

Without exposing a client command identity on each authoritative user event,
exact cross-operator correlation is impossible. If web and Flutter both capture
baseline `N`, the first authoritative user row advances both clients to `N+1`
and retires both ghosts. The second sender can therefore lose its placeholder
before its own row publishes. This is intentional and bounded: the transcript
still contains the first real row, the second real row converges through tail or
newest-page reconciliation, no row is duplicated, and no placeholder survives
beside either real row. Payload matching would trade this short cosmetic gap for
incorrect correlations and duplicate rendered messages.

An exact future contract would require an optional, bounded, capability-gated
client command identifier on Peon's authoritative `user_message` event. It
would need to survive provider replay and transcript pagination and remain
opaque to clients. No such contract is introduced here because count-based
retirement is safe and the remaining behavior is cosmetic.

## Executable race matrix

The web composer tests cover delayed publication, concurrent early retirement,
the 60-second bound, ambiguous retry identity, permanent-refusal identity, and
payload changes. Web pagination tests cover duplicate/replayed event IDs and
newest-page overlap. Flutter composer tests cover the same count race, queue
transition, expiry, refusal, and request-ID rules; repository and transcript
controller tests cover duplicate tail storage, newest-page reconciliation,
reconnect, foreground resume, and post-submit refresh coalescing.

Run the cross-client proof from the repository root:

```sh
npm test -w @rnm-dev/overseer-web
cd apps/client && flutter test \
  test/features/sessions/application/session_composer_controller_test.dart \
  test/features/sessions/application/transcript_controller_test.dart \
  test/features/sessions/data/default_followup_repository_test.dart \
  test/features/sessions/data/default_session_repository_test.dart
```
