# Notification sound follows the client you last used

One operator, several open clients: a desktop browser window that stays
connected for days and a phone that joins and drops all the time. Every client
used to play the session sounds, so a phone in a pocket kept announcing finished
runs while the operator was sitting at the desktop.

Audio ownership fixes exactly that and nothing else. Only the operator's top
client plays sound; every other client keeps working normally — live events,
presence, push notifications and unread marks are untouched.

## The stack

`apps/server/src/modules/presence/audioFocus.ts` keeps, per user, an ordered list of that
user's clients — most recently picked up first.

| Signal | Effect |
| --- | --- |
| A client connects for the first time | Goes on top. It can only have been opened in front of the operator. |
| An extra socket from a client already connected | Nothing. A fleet-dashboard workspace opens its own socket from the same tab. |
| A client reconnects after its last socket dropped | Goes on top **only if** it was in front of the operator when it vanished. A phone reconnecting from a pocket keeps its place. |
| A client reports itself active again (tab visible + focused, app foregrounded, `audio:claim`) | Goes on top. Returning to a machine is the strongest "use this one" signal there is. |
| A client reports itself hidden, unfocused or backgrounded (`audio:release`) | Stays where it is, but is outranked by any connected client that is active. |
| A client never says who it is | Stays out of the stack entirely: it is told nothing, owns nothing, and takes nothing from anyone. |
| A client's last socket closes | It stops being a candidate; the sound falls to whatever is underneath. Its entry and focus state are remembered for 10 minutes so a flapping link cannot make it look brand new. |

The owner is the first *connected* client that is active; if none of them is
active — everything is backgrounded, which is precisely when a sound is worth
playing — it is the first connected client outright.

State is per process and in memory, like the rest of presence. A restart simply
re-derives it from the reconnects.

## The wire

Ownership rides the existing live socket (`/api/ws`, `apps/server/src/liveSocket.ts`).
Four messages, all optional — a client that sends none of them behaves exactly as
it did before this existed.

| Message | Direction | Meaning |
| --- | --- | --- |
| `hello` field `clientId` | client → server | This client's identity. One id per browser tab, per install on a native app. All sockets sharing it are one client. |
| `{"type":"audio:claim"}` | client → server | The operator is in front of this client right now: it came to the foreground, regained focus, or they just pressed something. Moves it to the top. |
| `{"type":"audio:release"}` | client → server | They are not: backgrounded, hidden, screen off. Keeps the connection, gives up the sound. |
| `{"type":"audio","primary":boolean}` | server → client | Whether this client may play. Sent once after every `hello` and thereafter only when the answer changes. |

`presence:set`'s existing `active` flag is treated as the same signal as
`audio:claim`/`audio:release`, which is why the web app needs neither — its tab
visibility already travels with presence.

Ownership is per operator, not per workspace: which workspace a socket happens to
be looking at is irrelevant to which speaker should make a noise.

## What a client has to implement

**Play by default.** The absence of an `audio` message means play. A client that
has not connected, or one talking to an older overseer, must never mute itself
waiting for permission.

**Desktop web** — done, in `apps/web/src/audioFocus.ts` and `apps/web/src/liveSocket.tsx`.
The tab id lives in `sessionStorage`, focus and visibility ride along with
presence, and starting a session claims the sound outright.

**The mobile app** — not done. Its source is not in this repository, and it takes
three things:

1. Send a `clientId` in `hello`: a UUID generated once and stored in the app's
   persistent storage. Per install, not per launch — a relaunch has to be
   recognised as the same client coming back, not a new one arriving.
2. Send `audio:claim` when the app becomes active and `audio:release` when it
   resigns active / enters the background. This is the whole of the phone's
   focus story; there is no tab visibility to lean on.
3. Gate its own sound on the last `audio` message, defaulting to play.

Until it does, the app stays out of the stack: it keeps playing its own sounds as
it does today, and — deliberately — it cannot take the sound away from the
desktop. A client that cannot hear "stay quiet" must not be able to say it.

Note what step 2 buys, because it is the whole point of the feature: a phone that
reports going into a pocket hands the sound back to the desktop *without
disconnecting*, and a phone that reconnects on a flaky link while backgrounded
does not steal it.

## The browser

`apps/web/src/audioFocus.ts` holds this tab's id and its current verdict.
`apps/web/src/peonSounds.ts` gates both the one-shot sounds and the working ambience
on it, and stops ambience already playing when the tab loses the sound mid-turn.

**The default is to play.** A tab that has not connected yet, or one talking to
an overseer that never mentions audio, must never end up silently muted.

Starting a session claims the sound for the client it was started from
(`claimAudioFocus()` in `apps/web/src/pages/peon/PeonNewSession.tsx`), which both
takes effect locally at once and tells the overseer to quiet the others.

## What this does not cover

- Push notifications and iOS Live Activities are unaffected — see
  [push notifications](push-notifications.md). They target devices, not tabs, and
  answer to a different signal.
- Two tabs on the same machine are two clients. The focused one owns the sound.
- Nothing is persisted. Ownership is a property of live connections only.
