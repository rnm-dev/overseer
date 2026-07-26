# Running-session system activities

Overseer mirrors sessions initiated by the signed-in operator onto system
surfaces:

- iOS 16.2 and newer: ActivityKit Live Activity on the Lock Screen and Dynamic
  Island where available.
- Android: low-importance ongoing live-signal notification.
- Other platforms: no-op capability implementation.

The app treats this as a capability behind
`core/live_activities/session_activity.dart`; feature and presentation code do
not branch on the operating system.

## Ownership and lifecycle

The workspace WebSocket's authoritative running-session snapshot is the source
of truth. Its compact session projection retains `author`, title, preview,
project, and timestamps. The coordinator publishes a session only when its
author case-insensitively matches the authenticated operator's email or GitHub
login. A missing author is not assumed to be owned.

Each activity has a stable composite ID of workspace, Peon, and session. Native
implementations synchronize the complete desired set instead of processing
imperative start/stop calls. This makes updates idempotent and lets a cold app
launch:

1. update activities left by an earlier process;
2. start newly discovered owned sessions;
3. end activities no longer present in the authoritative running snapshot;
4. clear all activities on sign-out.

Android persists only the stable activity IDs needed to cancel stale
notifications. Session content and credentials are not persisted by this
layer. iOS queries ActivityKit for the existing activities.

## Live-signal design

The system activity is intentionally a live signal rather than a conventional
progress meter. It shows only data Overseer actually knows:

- session title and project;
- latest available preview;
- elapsed runtime;
- relative age of the last session activity;
- the real count of the operator's concurrently running sessions.

The Lock Screen and Dynamic Island use a mint/cyan pulse mark, `LIVE SIGNAL`
label, signal age, and elapsed timer. Android uses the same language in an
ongoing notification and groups multiple owned sessions into a single
expandable stack. No percentage or made-up stage is displayed.

## Background and push boundary

Live WebSocket changes update both platforms while the app process is alive.
iOS Live Activities and Android ongoing-session surfaces reconcile from the
currently selected Overseer runtime. Other authenticated Overseer runtimes keep
their fleet and workspace sockets warm, but do not install competing handlers
for the process-global native activity channel.
iOS also requests an ActivityKit update token for every locally started
activity. The authenticated app registers that token at
`PUT /api/push/live-activities`; it remains separate from the device's ordinary
FCM registration token.

When the server commits a matching session event, the durable push outbox sends
an ActivityKit `update` or `end` payload through Firebase Admin's APNs bridge.
The content state carries only server-known title, project, preview, phase, and
timestamps. `needs_human` remains an active amber state. Explicit completion,
failure, or cancellation ends the activity and leaves its terminal card visible
for 90 seconds. Sign-out disables every Live Activity registration for that
authenticated device.

This is update-token delivery, not push-to-start: Overseer must discover the
operator-owned running session and start its Live Activity locally once. After
that, remote updates continue while the app is suspended. Firebase must have an
APNs authentication key configured for the iOS app, and the Overseer server
must have `OVERSEER_FIREBASE_SERVICE_ACCOUNT_JSON`.

Android ongoing notifications reconcile from the live socket while the process
is active. Background reconciliation is unsupported because the FCM payload
does not contain the ownership proof and complete activity state required to
synchronize the notification set safely.

Every per-session system surface opens
`overseer[-dev]://open/session?workspaceId=…&peonId=…&sessionId=…`. The router
preserves that destination through auth restoration and opens the cached-first
session detail. The Android multi-session summary intentionally opens the app
home because it represents more than one destination.
