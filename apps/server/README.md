# overseer-server

Fleet control plane for Peon. Holds a registry of Peons and fans out control
over their authenticated Tailscale endpoints, so one operator API drives the
fleet.

See [`PROTOCOL.md`](./PROTOCOL.md) for the wire contract.

## How it fits together

```
 operator ──/fleet/* (operatorApiKey)──► OVERSEER ──/agent/v1/* (fleetToken)──► peons
 peons ────/agent/v1/peons/register + heartbeat (fleetToken)──────────────────► OVERSEER
```

- **Peons self-register** (`peonRegistrar.ts` on the Peon) with the Tailscale
  MagicDNS URL Overseer should use.
- **The overseer is the client** for all control: `/fleet/*` calls proxy
  through to the target Peon's authenticated Fleet HTTP API.
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
                      "overseerUrl": "https://overseer.example.com" }
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

A peon is online exactly while its control socket is connected — there is no
heartbeat timeout to configure. An offline peon still appears in the registry;
proxied calls to an unreachable one return `502 PEON_UNREACHABLE`.

## Config (env)

Two variables are required — `DATABASE_URL` and `OVERSEER_PUBLIC_URL` — and
everything else has a working default. The full list with defaults and the
reasoning behind each is [docs/configuration.md](../../docs/configuration.md);
the template to copy is `deploy/docker-compose.yml`, a complete install with
every setting written inline.

## Not yet built

- Operator dashboard UI (this is API-only so far).
- Per-peon tokens (one shared fleet token today).
- Concurrency/admission policy (per-peon ceilings, per-session soft-locks) — the
  place to enforce what the peon deliberately doesn't (see PROTOCOL.md).
