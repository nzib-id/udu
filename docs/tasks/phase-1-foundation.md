# Phase 1 — Foundation

**Goal:** Project skeleton jalan — Phaser frontend render empty map, Node backend hold placeholder state, keduanya connected via WebSocket. Deployed publicly.

**Estimate:** ~1-2 hours

**Status:** ✅ Complete (2026-04-24)

**Prerequisites:** Phase 0 complete

## Tasks

### Project structure

- [x] Create subdirs: `frontend/`, `backend/`, `shared/`, `data/`, `logs/`
- [x] Root `package.json` untuk workspace (kept existing for vitepress)
- [x] `shared/types.ts` — shared interfaces (Stats, Action, GameState, etc.)
- [x] `shared/config.ts` — MAP_CONFIG, DECAY_RATES, TIME_CONFIG, NETWORK_CONFIG

### Backend scaffold

- [x] `backend/package.json` + deps (ws, better-sqlite3, tsx, typescript)
- [x] `backend/tsconfig.json` (target ES2022, module NodeNext, noEmit — run via tsx)
- [x] `backend/src/server.ts` — HTTP + WebSocket server on port 4247, `/api/status` + `/ws`
- [x] `backend/src/db.ts` — SQLite init + migration runner (uses `PRAGMA user_version`)
- [x] `data/migrations/001_initial.sql` — schema DDL (lineage, character, rule, event, resource_state, reflection)
- [x] `backend/src/game-loop.ts` — tick loop at 500ms, computes GameTime from real-ms
- [x] Scripts: `dev` (tsx watch), `start` (tsx), `typecheck`

### Frontend scaffold

- [x] `frontend/` init — Vite + vanilla TS + Phaser 3.87
- [x] `frontend/src/main.ts` — Phaser game config + HUD + WS wiring
- [x] `frontend/src/scenes/MapScene.ts` — empty map render
- [x] `frontend/src/network/ws-client.ts` — WebSocket connect + state sync + reconnect
- [x] `frontend/src/ui/hud.ts` — time/char/resources/status readouts

### Map rendering (empty)

- [x] Render 80x60 grid (checkerboard solid colors + 15%-alpha grid lines)
- [x] Camera zoom 2x, responsive resize via `Phaser.Scale.RESIZE`
- [x] No entities yet (no character, no resources)

### WebSocket plumbing

- [x] Backend broadcasts `state_update` every 1s (throttled via `NETWORK_CONFIG.stateBroadcastMs`)
- [x] Frontend receives + pushes to HUD, emits `state_update` event to Phaser game
- [x] Reconnect logic: exponential backoff `[1s, 2s, 4s, 8s, 16s, 30s]`

### Dev tooling

- [x] `docker-compose.yml` + 3 Dockerfiles (backend/frontend/docs). All services jalan di Docker, konsisten dengan Loodee Studio stack.
- [x] `.dockerignore` added — skip node_modules, dist, git, logs
- [x] `shared/package.json` with `"type": "module"` — required supaya tsx di container resolve named exports dari shared correctly.
- [x] `.gitignore` — inherited from Phase 0 (covers node_modules, data/*.db, logs/, dist/)
- [x] `README.md` updated with dev/prod commands, port map, and Docker workflow

### Deploy Phase 1

- [x] `docker compose build` → builds all 3 images (backend ~250 MB, frontend ~180 MB, docs ~55 MB)
- [x] `docker compose up -d` → backend + frontend + docs containers up
- [x] `udu.loodee.art` already in `~/.cloudflared/config.yml` ingress (from Phase 0 prep); DNS CNAME added via `cloudflared tunnel route dns db112951-… udu.loodee.art`
- [x] No cloudflared reload needed (ingress config already contained entry)
- [x] Verify public tunnel: `curl --resolve` returns 302 to CF Access login (expected — CF Access bypass policy is a Phase 0 follow-up for Nzib)

### Verify

- [x] Localhost frontend serves HTML (2.3KB) at `http://127.0.0.1:4246/`
- [x] `GET /api/status` proxied through frontend → backend, returns `{"status":"ok",...}`
- [x] WebSocket `ws://127.0.0.1:4246/ws` opens, streams `state_update` at ~1 Hz
- [x] `docker compose restart backend` triggers WS close on client (frontend has backoff reconnect wired)
- [x] `docker compose logs backend` — only `[udu-backend] listening on :4247`; no errors

## Implementation notes / deviations from doc

- **Runtime: Docker Compose, NOT pm2.** Phase 0 deployment.md-nya nulis pm2, tapi Nzib mau konsisten sama Loodee Studio stack (Paperless/NocoDB/Kimai semua Docker). Docker-ified dalam session ini. pm2 entries (`udu-backend`, `udu-frontend`, `udu-docs`) dihapus + `pm2 save`.
- **Backend run mode:** tsx at runtime inside container. Alasan: dengan `rootDir: ..` untuk include `../shared`, tsc emit nested `dist/backend/src/…`. tsx works directly off `.ts` — zero ceremony. Multi-stage Dockerfile: stage 1 install deps (incl. python3/make/g++ for `better-sqlite3` native), stage 2 slim runtime.
- **Frontend server:** custom `frontend/server.mjs` (~80 LOC) instead of `npx serve` (yang gak handle WebSocket upgrade). Uses `http-proxy` to forward `/api` + `/ws` ke `backend:4247` (Docker DNS). Binds `0.0.0.0:4246` (bukan `127.0.0.1`) supaya Docker port forward jalan.
- **`shared/package.json`:** ditambahkan dengan `"type": "module"`. Tanpa ini, tsx di container default ke CJS dan `import { MAP_CONFIG }` cuma dapet `default` export. Di host gak kelihatan karena ancestor package.json udah `"type": "module"`, tapi di container `shared/` jadi orphan tanpa ancestor — jadi butuh marker sendiri.
- **Docker volumes:** `./data` bind-mounted ke `/app/data` supaya SQLite DB + migration files persist di host (gampang di-backup, survive container recreate).
- **CF Access:** public bypass policy for `udu.loodee.art` still pending (Nzib manual action in Zero Trust dashboard — tracked in Phase 0 follow-ups).
- **System DNS quirk:** WSL systemd-resolved gak resolve subdomain baru `loodee.art` for ~minutes, tapi Cloudflare edge DNS (1.1.1.1 DoH) resolve immediately. Traffic works end-to-end via `curl --resolve`.
