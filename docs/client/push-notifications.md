# Push notifications

Overseer Mobile uses Firebase Cloud Messaging for native Android and iOS push
notifications. Registration is tied to the authenticated Overseer device, but
the Firebase registration token is a separate rotating identifier.

## Client lifecycle

After authentication is restored or completed, the app:

1. requests the operating system notification permission;
2. obtains the current FCM registration token;
3. sends it to `PUT /api/push/subscriptions` with provider `fcm`, the native
   platform, and the active Firebase app ID;
4. replaces the server subscription when Firebase rotates the token; and
5. deletes the active subscription on logout or account replacement.

Push setup never blocks authentication or app startup. A failed registration is
retried on the next authenticated launch or Firebase token refresh. Tokens are
never logged. Android and iOS use separate Firebase applications for the `dev`
and `prod` flavors.

Android 13 and later use `POST_NOTIFICATIONS`. iOS enables the Push
Notifications entitlement and the `remote-notification` background mode.
While the app is foregrounded, both mobile platforms render the same in-app
notification card above the current cached UI. The card opens the destination
and can be dismissed; it expires after eight seconds. iOS keeps badge delivery
enabled but suppresses the duplicate system alert and sound while foregrounded.
Android and iOS continue to use their operating-system notification surfaces
while the app is backgrounded.

Normal FCM taps are consumed from both the terminated-launch message and the
background-open stream. Attention notifications carry bounded `workspaceId`,
`peonId`, and `sessionId` routing fields plus `kind: attention`; the client
opens the referenced cached-first session detail. The accompanying `cursor` is
an event-log resume token and is not used for routing. Legacy `session` and
`peon` kinds remain accepted for compatibility, with Peon events opening a
conservative cached-first Peon shell whose cached projects and sessions render
while fleet identity refreshes. The same destinations are available as:

```text
overseer[-dev]://open/peon?workspaceId=…&peonId=…
overseer[-dev]://open/session?workspaceId=…&peonId=…&sessionId=…
```

The destination survives authentication restoration and a subsequent sign-in.
After a fleet load, the app records a non-secret workspace-to-connection hint
in flavor-isolated preferences. A cold notification or deep link uses that
hint to select the originating saved Overseer connection before restoring its
connection-namespaced secure token and Drift cache. If no hint exists, a sole
saved connection can be selected safely; with multiple ambiguous connections,
the destination is retained while the user chooses a connection. Server URLs
and workspace identifiers are routing metadata, not credentials. FCM and
device tokens never enter this mapping.

The main screen's Settings card reflects the current operating-system
permission in a Notifications toggle. Turning it on retries the native
permission request and, after approval, retries FCM subscription registration.
If the user already denied the prompt and the operating system will not show it
again, the app presents instructions with a direct link to this app's
notification settings. Turning an enabled toggle off uses the same system
settings path because apps cannot revoke their own notification permission.
The toggle refreshes when the app resumes.
If permission becomes enabled while the system settings screen is open, the
resume refresh also retries authenticated FCM subscription registration
immediately; the user does not need to relaunch the app.

### Windows

Windows uses native toast notifications delivered from the authenticated live
workspace connection. On startup the unpackaged runner registers its Windows
app identity and an `Overseer Desktop` Start menu shortcut pointing to the current
executable. Enable Notifications in Settings to save the local opt-in
and show a confirmation banner. Turning the switch off stops future alerts;
Windows notification settings and Do Not Disturb still control OS presentation.
The switch refreshes OS permission on resume and links to Windows notification
settings when delivery is disabled there.

Only new unread completion attention events produce alerts, matching the server's
mobile push rule. Request acknowledgements, read receipts, duplicate cursors and
events replayed up to the socket snapshot barrier do not. Notification failures
are isolated from durable cache/cursor updates. Toasts contain generic completion
text and bounded routing identifiers, without credentials or transcript content.
Clicking a toast while the app is running restores its window and uses the shared
authenticated session navigation and workspace-to-connection hints.

Keep the app running (minimized is fine) and connected to the desired Overseer.
When the window loses focus, live presence falls back to the workspace so an
open but unwatched session does not suppress its completion alert; returning to
the app restores the current route's presence.
This is live desktop delivery: no new alerts are received after exiting the app,
and reconnect does not generate a backlog of old notifications. Windows does not
register an FCM subscription. The unpackaged runner does not support launching
from an old toast after exit or removing delivered toasts from notification history.
macOS, Linux, and web still expose no notification delivery capability.

Native Windows verification (shows a real confirmation banner and restores the
previous app preference; no server or account is used):

```sh
flutter test -d windows integration_test/windows_notifications_test.dart
```

Then enable Notifications in the normal app, minimize it, finish a requested run
from another device, and click the resulting alert. Verify the right session
opens, disabling the toggle stops alerts, and reconnect does not replay old ones.

## Server delivery

The Overseer server stores subscriptions independently from login devices and
queues accessible session and Peon events in its durable push outbox. The worker
sends FCM notification and data payloads through Firebase Admin, retries
transient failures with exponential backoff, and disables registration tokens
that Firebase reports as permanently invalid.

Configure the complete service-account JSON as a deployment secret:

```sh
OVERSEER_FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
```

Never commit the JSON or print it in deployment logs. Use a service account
scoped to the Overseer Firebase project. For iOS delivery, upload an APNs
authentication key for both Apple bundle IDs in Firebase Console. Android needs
no additional provider credential after the Firebase Admin service account is
configured.

Until the server secret is installed, FCM outbox items remain undelivered and
retry with backoff. This is intentional: missing deployment credentials must
not discard durable notifications.

## Verification

For each flavor:

1. sign in on a real device and accept notification permission;
2. deny or revoke permission, retry from the Settings toggle, and confirm its
   fallback button opens the app-specific operating-system settings;
3. enable notifications there and confirm the toggle refreshes on return;
4. confirm the server lists an active `fcm` subscription for the device;
5. background the app and produce a visible session or Peon event;
6. confirm the notification appears without exposing credentials in logs;
7. tap it from background and terminated states and confirm the cached-first
   Peon/session destination survives authentication restoration;
8. foreground the app, trigger an event, and verify the in-app card opens the
   same destination without a duplicate iOS system banner;
9. with two saved Overseer connections, confirm the workspace routing hint
   selects the originating connection; and
10. sign out, produce another event, and confirm the device receives nothing.
