# Managed plugin inquiries

The Flutter session screen supports Peons advertising
`managed-plugin-inquiry-v1`. It reads the current session's requests from
`GET /api/workspaces/:workspaceId/peons/:peonId/sessions/:sessionId/inquiries`
and submits an explicit `install` or `cancel` action to the corresponding
`.../:inquiryId/respond` route.

Only the standardized `inquiry-v1` envelope with kind
`managed_plugin_install` is accepted. Unknown versions, kinds, statuses, or
malformed plugin metadata fail closed. The client renders native widgets only;
it does not render plugin-provided HTML, surface the public `inquiryId`, or
accept native app-server request identifiers. The public response contains
sanitized `authPolicy` and `appsNeedingAuth` summaries, not authentication URLs,
tokens, or provider payloads.

The compact card appears in the session transcript flow. Pending requests have
one explicit Install action and a secondary Cancel action. Both actions are
disabled together while a response is in flight and while the Peon is offline.
A transient submission failure restores the pending state and retains the same
request identity for a safe retry. Terminal installed, authentication-needed,
cancelled, expired, failed, refused, and stale states have no action controls.

The controller refreshes on mount and every 15 seconds while the Peon is
online. Rebuilding the scope after a fleet reconnect starts an immediate fresh
read. Local expiry removes actions at the advertised deadline even before the
next server response; the following refresh remains authoritative. The card
uses theme color roles, a 560-pixel maximum width, responsive stacked actions
below 300 pixels, live-region semantics, and the session page's existing safe
area and composer-aware transcript padding.
