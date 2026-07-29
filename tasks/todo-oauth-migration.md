# Replace magic-link auth with GitHub OAuth + invite links

## GitHub side (Viktor)
- [x] Create OAuth App, callback `https://overseer.rnm.dev/auth/github/callback`
- [x] Client id + secret provided → into `.env`

## Backend
- [ ] `.env` — add GITHUB_CLIENT_ID/SECRET, drop ADMIN_EMAIL + AUTH_DEV_ECHO
- [ ] `config.ts` — github config, drop magic-link/email config
- [ ] `github.ts` (new) — code→profile exchange
- [ ] `auth.ts` — drop OTP/magic-link, add ensureUserFromGithub, github user cols
- [ ] `db.ts` — migration 002: users github cols + workspace_invitations, drop auth_challenges
- [ ] `workspaces.ts` — drop addMemberByEmail, add invite create/list/revoke/accept
- [ ] `server.ts` — /auth/github(+config), invites routes, rename /fleet→/api
- [ ] `index.ts` — drop bootstrapAdmin
- [ ] delete `mailer.ts`

## Frontend
- [ ] `api.ts` — /fleet→/api
- [ ] `auth.tsx` — github login + callback exchange
- [ ] `pages/Login.tsx` — single GitHub button
- [ ] `pages/GithubCallback.tsx` (new)
- [ ] `pages/Join.tsx` (new) — /join/:token
- [ ] `App.tsx` — callback + join routes
- [ ] `Dashboard.tsx` — invite-link panel + share button
- [ ] `i18n.tsx` — github/invite/join strings

## Ops
- [ ] nginx vhost: location /fleet → /api
- [ ] vite.config proxy /fleet → /api
- [ ] restart app, smoke-test flow

## Review — DONE 2026-07-07
- Backend: config/github/auth/db(002)/workspaces/server/index rewired; mailer deleted. `tsc --noEmit` = 0.
- Frontend: api/auth/Login/GithubCallback/Join/App/Dashboard/i18n. src type-clean (only pre-existing vite.config `process` noise).
- Namespace: /fleet → /api everywhere (router var too), nginx `location /api`, vite proxy, SPA served for /auth + /join.
- DB verified live: migration 002 applied, users has github cols + unique idx, workspace_invitations created, auth_challenges dropped.
- Smoke: /api/auth/github/config ✓, /healthz ✓, /api/auth/me→401 ✓, /fleet→404 ✓, GitHub authorize→302 ✓.
- NOT machine-testable: the human GitHub click (needs a browser+GitHub session). Wiring verified up to GitHub accepting client_id.
- Left for user: real end-to-end login in browser; deploy CLAUDE.md doc still says /fleet+magic-link (stale).
