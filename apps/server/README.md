# overseer-server

Fleet control plane for Peon (still its own repository, `rnm-dev/peon`; it
becomes `apps/peon` here in OVSR-240). Holds a registry of peons and fans out
control over a **Tailscale tailnet**, so a single operator API drives many peons
— including office desktops behind NAT (no public IP).

See [`PROTOCOL.md`](./PROTOCOL.md) for the wire contract.

## How it fits together

```
 operator ──/fleet/* (operatorApiKey)──► OVERSEER ──/agent/v1/* (fleetToken)──► peons
 peons ────/agent/v1/peons/register + heartbeat (fleetToken)──────────────────► OVERSEER
```

- **Peons self-register** (`peonRegistrar.ts` on the peon) — the overseer
  learns each peon's tailnet address from the *source* of that request, so a
  NAT'd peon never needs an inbound address.
- **The overseer is the client** for all control: `/fleet/*` calls proxy
  through to the target peon's `/agent/v1/*` API over the tailnet.
- **Two independent secrets / two auth boundaries:**
  - `OVERSEER_FLEET_TOKEN` — shared with peons (register/heartbeat + the
    bearer the overseer presents when calling a peon). Must equal each peon's
    `overseerToken`.
  - `OVERSEER_API_KEY` — operator credential for `/fleet/*`. Unrelated to the
    fleet secret.

## Run

```sh
npm install
DATABASE_URL=postgres://user:pass@host:5432/overseer \
OVERSEER_FLEET_TOKEN=<shared-with-peons> \
OVERSEER_API_KEY=<operator-secret> \
OVERSEER_HOST=0.0.0.0 \
npm run dev        # or: npm run compile && npm start
```

Postgres is required (the schema migrates itself on boot — see `src/db.ts`).

Then point each peon at it:

```sh
# on each peon box
PATCH /api/settings { "overseerToken": "<same as FLEET_TOKEN>",
                      "overseerUrl": "http://<overseer-tailnet-host>:5000" }
```

## API

### North-bound (peons; `Authorization: Bearer <fleetToken>`)
```
POST /agent/v1/peons/register
POST /agent/v1/peons/:id/heartbeat
POST /agent/v1/peons/:id/events      { epoch, events:[{seq, session}] } — keeps the index live
```

### Operator (`X-Api-Key: <operatorApiKey>`, or Bearer)
```
GET    /fleet/peons                         registry + online/load
GET    /fleet/peons/:id
DELETE /fleet/peons/:id                      forget a peon
GET    /fleet/sessions[?peonId&status&limit&offset]  all sessions across the fleet (from the index)
GET    /fleet/status                         aggregate live status across the fleet
GET    /fleet/peons/:id/status
GET    /fleet/peons/:id/sessions[/:sid][/transcript]
POST   /fleet/peons/:id/sessions             start   (X-Actor forwarded as Peon-Actor)
POST   /fleet/peons/:id/sessions/:sid/followup | cancel
POST   /fleet/peons/:id/control/pause | resume
GET    /fleet/peons/:id/sessions/:sid/stream SSE tail (proxied)
GET    /fleet/peons/:id/files/<path>[?stat=1] download / metadata (Range-capable)
PUT    /fleet/peons/:id/files/<path>          upload (streamed; Peon-Content-Sha256 forwarded)
```

File transfer is a transparent proxy to the peon's sandboxed `/files` — it
honours `Range`, streams uploads without buffering, and forwards the
`Peon-Content-Sha256` integrity header. It only works if the target peon has
`fileTransferRoot` set (otherwise the peon's own `503 FILES_DISABLED` passes
through).

An offline peon (no heartbeat within `OVERSEER_OFFLINE_AFTER_MS`, default 45s)
still appears in the registry; proxied calls to an unreachable peon return
`502 PEON_UNREACHABLE`.

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `OVERSEER_PORT` | `5000` | listen port |
| `OVERSEER_HOST` | `127.0.0.1` | bind interface (set `0.0.0.0` behind the tailnet) |
| `OVERSEER_FLEET_TOKEN` | — | shared peon secret (empty ⇒ registration 503s) |
| `OVERSEER_API_KEY` | — | operator secret (empty ⇒ `/fleet` 503s) |
| `DATABASE_URL` | — | Postgres connection string (required) |
| `OVERSEER_RECONCILE_INTERVAL_MS` | `30000` | how often the session index re-pulls each peon |
| `OVERSEER_PREVIEW_DOMAIN` | `preview.overseer.rnm.dev` | wildcard domain used for isolated HTML preview tokens |
| `OVERSEER_PREVIEW_TOKEN_TTL_MS` | `600000` | HTML preview token lifetime (clamped to 30s–1h) |
| `OVERSEER_OFFLINE_AFTER_MS` | `45000` | offline threshold |

## Not yet built

- Operator dashboard UI (this is API-only so far).
- Per-peon tokens (one shared fleet token today).
- Concurrency/admission policy (per-peon ceilings, per-session soft-locks) — the
  place to enforce what the peon deliberately doesn't (see PROTOCOL.md).
