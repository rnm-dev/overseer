# Running-session system activities

Overseer exposes one aggregate system activity for each selected Overseer
connection:

- iOS 16.2 and newer: ActivityKit Live Activity on the Lock Screen and Dynamic
  Island where available;
- Android: one low-importance ongoing notification;
- other platforms: a no-op capability.

The capability lives behind `core/live_activities/session_activity.dart`.
Feature and presentation code do not branch on the operating system.

## State and lifecycle

The authoritative workspace WebSocket running-session snapshots are the source
of truth. A running session contributes only when its `author`
case-insensitively matches the authenticated operator's email or GitHub login.
A missing author is not treated as owned.

The activity contains:

- `runningCount`: owned sessions currently present in authoritative running
  snapshots;
- `completedCount`: cached sessions whose per-operator `attentionUnread` flag
  is true;
- `oldestStartedAt`: the earliest known start time among owned running
  sessions;
- `updatedAt`: the latest known activity time among those sessions.

There is never one activity per session. The stable activity identity is scoped
to the saved Overseer connection. The activity exists while `runningCount` is
non-zero. When the final run disappears, iOS ends it and leaves the terminal
card visible for 90 seconds; Android removes its ongoing notification.
Sign-out clears the selected connection's activity.

The client synchronizes the complete desired aggregate instead of issuing
imperative start/stop calls. This makes foreground and cold-launch
reconciliation idempotent. Cached unread changes update `COMPLETED`
immediately, including when a session is marked read.

## Visual treatment

The Lock Screen and Dynamic Island use the UI kit palette:

- fel green for `RUNNING` and the live signal;
- forge amber for `COMPLETED` pending-read sessions;
- bone text on void and iron surfaces.

The primary duration is the elapsed time since `oldestStartedAt`; freshness is
shown as relative time since `updatedAt`. The aggregate activity opens the app
home because it represents multiple possible sessions.

## Background and push boundary

While the app process is alive, WebSocket and Drift changes reconcile the
activity. A cold launch also discovers currently running owned sessions and
repairs the local system surface.

The iOS client observes two separate ActivityKit token types:

- a device-scoped push-to-start token on iOS 17.2 and newer;
- an update token for the aggregate activity after ActivityKit creates it.

These tokens are not ordinary FCM registration tokens. The mobile client is
prepared to register them through authenticated Live Activity endpoints, but
remote aggregate start/update/end delivery depends on the backend task linked
from the project tracker. Until that backend contract ships, a session started
from the web while the app is terminated appears only after the next app
launch/reconciliation.

The backend contract must preserve one aggregate per user device and Overseer
connection, update all four fields from authoritative server state, and end it
only when the running count reaches zero. iOS 16.2 through 17.1 cannot use
push-to-start and always rely on launch reconciliation.

Android background reconciliation remains unsupported until the server provides
an authoritative aggregate data-message contract.
