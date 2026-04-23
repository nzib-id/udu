# Phase 1 — Foundation

**Goal:** Project skeleton jalan — Phaser frontend render empty map, Node backend hold placeholder state, keduanya connected via WebSocket. Deployed publicly.

**Estimate:** ~1-2 hours

**Prerequisites:** Phase 0 complete

## Tasks

### Project structure

- [ ] Create subdirs: `frontend/`, `backend/`, `shared/`, `data/`, `logs/`
- [ ] Root `package.json` untuk workspace (optional, bisa simple gak pake workspace)
- [ ] `shared/types.ts` — shared interfaces (Stats, Action, GameState, etc.)
- [ ] `shared/config.ts` — MAP_CONFIG, DECAY_RATES, etc.

### Backend scaffold

- [ ] `cd backend && npm init -y`
- [ ] Install deps: `typescript`, `@types/node`, `ws`, `@types/ws`, `better-sqlite3`, `@types/better-sqlite3`, `fastify` (optional)
- [ ] `backend/tsconfig.json` configured (target ES2022, module NodeNext)
- [ ] `backend/src/server.ts` — HTTP server + WebSocket server on port 4247
- [ ] `backend/src/db.ts` — SQLite init + migration runner
- [ ] `backend/data/migrations/001_initial.sql` — schema DDL
- [ ] `backend/src/game-loop.ts` — tick loop placeholder
- [ ] `backend/package.json` scripts: `dev` (tsx watch), `build` (tsc), `start` (node dist)

### Frontend scaffold

- [ ] `cd frontend && npm create vite@latest . -- --template vanilla-ts`
- [ ] Install Phaser: `npm install phaser`
- [ ] Remove Vite default template bloat
- [ ] `frontend/src/main.ts` — Phaser game config
- [ ] `frontend/src/scenes/MapScene.ts` — empty map render
- [ ] `frontend/src/network/ws-client.ts` — WebSocket connect + state sync
- [ ] `frontend/src/ui/` — placeholder HUD components

### Map rendering (empty)

- [ ] Render 80x60 grid dengan placeholder tiles (solid colors)
- [ ] Camera zoom 2x, responsive resize
- [ ] No entities yet (no character, no resources)

### WebSocket plumbing

- [ ] Backend sends placeholder `state_update` setiap 1 detik
- [ ] Frontend receive + console log
- [ ] Reconnect logic (backoff)

### Dev tooling

- [ ] `ecosystem.config.js` di root dengan 3 pm2 apps
- [ ] `.gitignore` proper (node_modules, data/*.db, logs/, dist/)
- [ ] `README.md` update dengan run instructions

### Deploy Phase 1

- [ ] Build frontend: `cd frontend && npm run build`
- [ ] Build backend: `cd backend && npm run build`
- [ ] `pm2 start ecosystem.config.js`
- [ ] `pm2 save`
- [ ] Add `udu.loodee.art` to cloudflared config
- [ ] Reload cloudflared
- [ ] Verify `udu.loodee.art` shows blank map + console log of state updates

### Verify

- [ ] Open `udu.loodee.art` in browser, see empty grid
- [ ] Open devtools console, see WebSocket state updates streaming
- [ ] Reload backend (pm2 restart), verify frontend auto-reconnect
- [ ] Check `pm2 logs udu-backend` shows no errors
