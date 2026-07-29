# Peon task — implement overseer enrollment (zero-touch recruitment)

**Owner:** peon repo devs · **Depends on:** overseer (done, live) · **Contract:** `app/PROTOCOL.md` §"Recruitment"

## Why
The overseer dropped the single shared fleet secret. It now mints a **per-peon,
workspace-scoped credential** (`pn_…`) and drives recruitment itself over the
tailnet. The overseer side is implemented and running. The peon side is **not** —
until it lands, recruitment only works in *manual* mode (an operator hand-sets
`overseerUrl` + token via `PATCH /api/settings`). Three additions unlock zero-touch.

## Concept — what the pairing secret is
Recruitment is chicken-and-egg: the overseer wants to hand the peon a `pn_…`
credential through `POST /agent/v1/enroll`, but that endpoint itself needs auth,
and a fresh peon has no overseer credential yet. The **pairing secret** is the
one-time bootstrap key that breaks the cycle:

1. A fresh peon (not yet recruited) generates a **pairing phrase** and prints it.
2. The human running the peon reads the phrase + the peon's tailnet address and
   gives both to an operator.
3. The operator enters them in the overseer's "Connect peon" form → the overseer
   calls `/enroll` with the phrase as the bearer.
4. The peon verifies the phrase, persists the minted `pn_…` credential, and
   **burns the phrase** (single-use).

So it is a short-lived, human-carried, single-use bootstrap — which is exactly
why it should be **memorable, not random hex**. We make it an orcish phrase like
`lok-tar-ogar-dabu`.

## The exact wire contract (overseer is the source of truth)
When an operator recruits a peon (enters its address + the **pairing phrase**), the
overseer calls the peon:

```
POST <peonBaseUrl>/agent/v1/enroll
Authorization: Bearer <pairing phrase>        # e.g. "lok-tar-ogar-dabu"
Peon-Protocol: 1
Content-Type: application/json

{ "overseerUrl": "http://overseer.<tailnet>.ts.net:5000", "overseerToken": "pn_xxxxxxxx" }
```

- The overseer waits **≤ 8 s** and reads `peonId` from the JSON response.
- Any non-2xx ⇒ the overseer **revokes** the minted credential and reports
  `ENROLL_FAILED` to the operator. So reject a bad/expired phrase with a 4xx.
- Source of truth: `app/src/server.ts` (`POST /workspaces/:wsId/peons/recruit`)
  and `app/src/peonClient.ts` (`callPeon` — note it prefixes `/agent/v1`).
- **No overseer change is needed for orcish phrases** — the phrase is just the
  string the operator pastes, forwarded verbatim as the enroll bearer.

---

## Task 1 — the pairing secret (orcish phrase)
**Where:** peon `src/daemon/` (a new `pairing.ts` + settings), surfaced by the peon CLI.

### Setting
Add a first-class `pairingSecret` to peon settings, **separate** from `overseerToken`.
`/enroll` (Task 2) authorizes on the pairing secret **or** the current `overseerToken`
(so an already-recruited overseer can re-point the peon). Every other `/agent/v1`
route stays gated on `overseerToken` exactly as today.

### Generate an orcish phrase
```ts
import { randomInt } from "node:crypto";

// Starter list — expand to >=256 words for production (entropy note below).
const ORC_WORDS = [
  "lok", "tar", "ogar", "zug", "dabu", "throm", "ka", "grom", "mash", "kaz",
  "mogu", "gul", "dan", "kek", "mag", "har", "thok", "gor", "nal", "rok",
  "zog", "kron", "thrall", "garrosh", "grommash", "durotan", "orgrim", "blackhand",
  "nerzhul", "drek", "thar", "mok", "nathal", "magor", "swobu", "gazlowe",
  "hellscream", "warsong", "frostwolf", "blackrock", "dragonmaw", "thundermaw",
  "burningblade", "maghar", "fel", "warchief", "peon", "grunt", "raider",
  "wolfrider", "headhunter", "doomhammer", "gorehowl", "shadowmoon", "bladefist",
  "kodo", "wyvern", "ripper", "skullsplitter", "bonechewer", "ragefire",
  "grimtotem", "boulderfist", "aka", "magosh",
];

export function orcishPhrase(words = 4): string {
  return Array.from({ length: words }, () => ORC_WORDS[randomInt(ORC_WORDS.length)]).join("-");
}
```
Example output: `grommash-dabu-fel-throm`, `zug-warsong-lok-kek`.

### Normalize + compare (so a human can type it forgivingly)
```ts
import { createHash, timingSafeEqual } from "node:crypto";

// "Lok Tar  Ogar_Dabu" and "lok-tar-ogar-dabu" must match.
export function normalizePhrase(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}
export function phraseMatches(candidate: string, stored: string): boolean {
  const a = createHash("sha256").update(normalizePhrase(candidate)).digest();
  const b = createHash("sha256").update(normalizePhrase(stored)).digest();
  return timingSafeEqual(a, b); // equal-length hashes → constant-time
}
```

### Lifecycle
- On boot with **no `overseerToken`** (never recruited): generate a phrase, **print it
  prominently** to the console, and arm `/enroll`. Never log it again after arming.
- `peon pair` CLI command: (re)generate + print a fresh phrase and arm a pairing
  window — used to re-point an already-recruited peon at a new overseer/workspace.
- **Single-use:** on a successful `/enroll`, clear `pairingSecret` so the phrase can't
  be replayed.
- **Armed window / TTL:** a phrase is valid ~15 min (configurable) after generation;
  after that `/enroll` on the phrase returns 401 until re-armed. (`overseerToken` auth
  on `/enroll` is not time-limited.)

### Security hardening (memorable phrases are safe *with* these)
- Entropy: `log2(N) * words`. With a **256-word** list and **4 words** ≈ **32 bits** —
  fine for a single-use, TTL'd, tailnet-only, rate-limited secret. Bump word count
  or list size to raise it. The 64-word starter above is ~24 bits — expand it.
- **Rate-limit** `/enroll` (e.g. 5 attempts/min) to blunt online guessing.
- Constant-time compare (above); tailnet-only exposure (deploy model already).
- Print the phrase once, on generation — do not persist it in logs.

---

## Task 2 — `POST /agent/v1/enroll` (new endpoint)
**Where:** peon `src/daemon/agentApi.ts` (mounted at `/agent/v1`) + settings persistence.

**Auth:** a valid **pairing secret** (armed, unexpired) **or** the peon's current
`overseerToken`. This endpoint must be reachable when `overseerToken` is still empty
(a fresh peon) — unlike the rest of the surface, which stays `overseerToken`-gated
(`503 AGENT_API_DISABLED` when empty).

**Request body:** `{ overseerUrl: string, overseerToken: string }` (the `pn_…` credential).

**Response:** `200 { "ok": true, "peonId": "<this peon's stable id>" }`

**Behavior:**
1. Authorize the bearer (pairing secret or overseerToken); else `401`.
2. Validate both body fields are non-empty strings → `400` otherwise.
3. Persist `overseerUrl` + `overseerToken` **atomically** (same path as `PATCH /api/settings`).
   This swaps the agent-surface bearer to the new `pn_` token.
4. **Burn the pairing secret** (single-use) if that's what authorized the call.
5. Return `peonId` **synchronously** — the overseer binds the credential to the peon
   from this response, before the first register arrives.
6. Trigger an **immediate re-register** with the new creds (don't wait for the next tick).
7. **Idempotent** — re-enrolling overwrites, re-pointing a peon to a new overseer/workspace.

**Note:** the new `overseerToken` invalidates the bearer that authed *this* request.
Send the response first; every subsequent north/south call uses the new token.

## Task 3 — react to `401` on north-bound calls (de-recruit)
**Where:** `src/daemon/peonRegistrar.ts` (register + heartbeat) and
`src/daemon/peonEventPusher.ts` (events).

Today only `404` is handled (overseer forgot me → re-register next tick). The
overseer now returns **`401 UNAUTHENTICATED`** when a credential is **revoked**.
Handle north-bound responses as:

| status | meaning | action |
|---|---|---|
| 2xx | ok | continue |
| 404 | overseer restarted / forgot me | re-register on next tick (unchanged) |
| **401** | **credential revoked** | **de-recruit: stop phoning home (or hard back-off), log once. Do NOT retry-storm.** A later `/enroll` resumes normal operation. |
| network / 5xx | transient | retry with backoff (unchanged) |

---

## Acceptance criteria
- Fresh peon (no `overseerToken`) boots → prints an orcish pairing phrase and arms `/enroll`.
- `POST /agent/v1/enroll` with `Authorization: Bearer <phrase>` (any of the forgiving
  spellings) + `{overseerUrl, overseerToken:"pn_test"}` → `200 {ok, peonId}`; settings
  now hold the new url + token; the phrase is **burned**.
- Immediately after, the peon registers at `overseerUrl` with `Authorization: Bearer pn_test`
  — the overseer shows it **online**.
- `peonId` from `/enroll` **==** the `peonId` used in the following register.
- Wrong / expired / already-used phrase → `401` (overseer reports `ENROLL_FAILED`,
  revokes the token).
- `peon pair` prints a fresh phrase; re-enroll with a different `overseerUrl`/token →
  peon re-points and re-registers there.
- Overseer revokes the credential → next register/heartbeat/events gets `401` → peon
  stops and logs **once** (no retry storm); a fresh `pair` + `/enroll` brings it back.
- `/enroll` is rate-limited (repeated bad guesses get throttled).

## Overseer preconditions (to test end-to-end)
- Overseer needs `OVERSEER_PEON_CALLBACK_URL` set to a **tailnet-reachable** overseer
  URL, or recruit 400s with `NO_CALLBACK_URL`.
- ⚠️ Tailscale isn't installed on `nid-dev` yet — until it is, test with the peon
  reachable on the same host/LAN and a callback URL the peon can actually reach.
- Recruit is triggered from the dashboard "Connect peon" (address + pairing phrase).
- Optional overseer nicety: relabel the recruit form's secret field to "Pairing phrase".

## Out of scope (already done / unchanged)
- register / heartbeat / events **envelopes** are unchanged — they just carry the
  new `pn_` token as the bearer (only the `401` handling in Task 3 is new).
- The south-bound `/agent/v1` API (status/sessions/control/files/stream) is
  unchanged; it's gated on `overseerToken`, which `/enroll` now sets to the credential.
