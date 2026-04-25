# Deployment

## Hosting target

- **Server**: Nzib's local server (same as Loodee Studio, Kimai, etc.)
- **Process manager**: Docker Compose (konsisten dengan stack Loodee Studio)
- **Public access**: via cloudflared tunnel → `*.loodee.art` DNS
- **CF Access**: **public** (no auth policy) — anyone with URL can view

## Domains

| Domain | Target | Purpose |
|--------|--------|---------|
| `udu.loodee.art` | localhost:4246 | Game frontend (Phaser) |
| `udu.loodee.art/ws` | localhost:4247/ws | WebSocket endpoint (proxied by frontend server, same origin) |
| `udu.loodee.art/api` | localhost:4247/api | REST admin endpoints |
| `udu-docs.loodee.art` | localhost:4245 | VitePress documentation |

**Note:** Naming pivot — awalnya rencana `docs.udu.loodee.art` (2-level subdomain), tapi Cloudflare Universal SSL cuma cover `*.loodee.art` (1-level). Pivot ke `udu-docs.loodee.art` untuk stay dalam SSL coverage tanpa bayar Advanced Certificate Manager.

## Ports

Semua service jalan di dalam Docker network `udu` (bridge). Host binding cuma `127.0.0.1` — public reach lewat cloudflared.

| Host port | Container | Service |
|-----------|-----------|---------|
| 127.0.0.1:4245 | `udu-docs` (nginx:80) | VitePress static |
| 127.0.0.1:4246 | `udu-frontend` (:4246) | Phaser static + proxy `/ws` & `/api` → backend |
| — (internal only) | `udu-backend` (:4247) | Node simulation + WS + REST |

Backend TIDAK exposed ke host — frontend container nge-proxy ke `http://backend:4247` via Docker network.

## Docker stack

File: `projects/udu/docker-compose.yml` + 3 Dockerfiles.

```yaml
name: udu

services:
  backend:
    build: { context: ., dockerfile: backend/Dockerfile }
    container_name: udu-backend
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: "4247"
      OLLAMA_URL: "http://172.21.160.1:11434"
      OLLAMA_MODEL: "qwen3:8b"
    volumes:
      - ./data:/app/data       # SQLite DB + migrations persist
    networks: [udu]
    expose: ["4247"]

  frontend:
    build: { context: ., dockerfile: frontend/Dockerfile }
    container_name: udu-frontend
    restart: unless-stopped
    environment:
      PORT: "4246"
      BACKEND_URL: "http://backend:4247"
    depends_on: [backend]
    networks: [udu]
    ports: ["127.0.0.1:4246:4246"]

  docs:
    build: { context: ., dockerfile: docs/Dockerfile }
    container_name: udu-docs
    restart: unless-stopped
    networks: [udu]
    ports: ["127.0.0.1:4245:80"]

networks:
  udu: { driver: bridge }
```

### Dockerfile summaries

- **backend/Dockerfile** — 2-stage `node:22-bookworm-slim`. Stage 1 install deps (incl. `python3 make g++` for `better-sqlite3` native build). Stage 2 copy `node_modules` + `src` + `/app/shared` + `/app/data/migrations`. Runtime: `./node_modules/.bin/tsx src/server.ts`.
- **frontend/Dockerfile** — 2-stage. Stage 1 `vite build` → `dist/`. Stage 2 slim runtime with `server.mjs` + http-proxy + bundled dist. Binds `0.0.0.0:4246`.
- **docs/Dockerfile** — 2-stage. Stage 1 `vitepress build docs`. Stage 2 `nginx:alpine` serving `.vitepress/dist`.

### Gotchas kept in repo

- `shared/package.json` exists with `"type": "module"`. Tanpa ini, tsx di container-nya default ke CJS dan named exports hilang (`import { MAP_CONFIG }` cuma dapet `default`).
- `frontend/server.mjs` bind ke `0.0.0.0` (bukan `127.0.0.1`) supaya Docker port forward bisa jalan.

## Cloudflared ingress

Add to `~/.cloudflared/config.yml`:

```yaml
ingress:
  # ... existing entries ...
  - hostname: udu.loodee.art
    service: http://127.0.0.1:4246
  - hostname: udu-docs.loodee.art
    service: http://127.0.0.1:4245
  - service: http_status:404
```

Then reload:
```bash
sudo systemctl reload cloudflared
# or: pkill -HUP cloudflared
```

## DNS setup

Cloudflare DNS (loodee.art zone):

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | udu | `<tunnel-uuid>.cfargotunnel.com` | Proxied |
| CNAME | udu-docs | `<tunnel-uuid>.cfargotunnel.com` | Proxied |

Tunnel UUID: `db112951-567c-439c-880e-3b651de13023` (shared dengan service lain)

Add via:
```bash
cloudflared tunnel route dns <tunnel-id> udu.loodee.art
cloudflared tunnel route dns <tunnel-id> udu-docs.loodee.art
```

**CF Access note:** Default policy di `*.loodee.art` adalah browser-login + service token (internal). Untuk bikin `udu.loodee.art` benar-benar public, Nzib harus tambahin Bypass Policy via Cloudflare Zero Trust dashboard:
- Applications → Self-hosted → `udu.loodee.art` → Policies → Add "Allow Everyone" policy first
- (Optional) Same for `udu-docs.loodee.art` jika mau docs public juga

## Build & deploy flow

### Any service — build image & restart
```bash
cd /home/nzib/.openclaw/workspace/projects/udu
docker compose build <service>      # <service> = backend | frontend | docs
docker compose up -d <service>
```

### All services
```bash
docker compose build
docker compose up -d
```

## Initial setup (run once)

```bash
cd /home/nzib/.openclaw/workspace/projects/udu
docker compose build
docker compose up -d
```

## Updates (git pull + redeploy)

```bash
cd /home/nzib/.openclaw/workspace/projects/udu
git pull
docker compose build
docker compose up -d         # recreates any container whose image changed
```

## Backup

- **SQLite DB** (`data/udu.db`) — penting, contains rules + lineage
- **Reflections history** — bagian dari DB
- Include in cron backup (`~/backup-loodee.sh`) — ADD in TODO

## Monitoring

- Live logs: `docker compose logs -f backend` (tail with `--tail=100` for last N lines)
- All services status: `docker compose ps`
- Health: `curl https://udu.loodee.art/api/status`
- DB size: `ls -lh data/udu.db` (host path, bind-mounted to `/app/data/udu.db` in container)
- Ollama connectivity: backend logs warning jika call gagal (fallback: skip reflection that day)

## Troubleshooting

### Backend can't reach Ollama
- Check WSL can reach Windows host: `curl http://172.21.160.1:11434/api/tags`
- If failing: check Windows firewall allows 11434 inbound
- Fallback: backend logs skip, reflection gak jalan hari itu, rules frozen — gameplay tetep jalan

### Frontend shows "connecting..." forever
- Check backend running: `docker compose ps backend`
- Check WebSocket endpoint: `wscat -c wss://udu.loodee.art/ws`
- Check backend reachable dari frontend container: `docker exec udu-frontend node -e "fetch('http://backend:4247/api/status').then(r=>r.text()).then(console.log)"`

### High Ollama latency
- Check GPU usage on Windows
- qwen3:8b should load once, stay hot 5 min
- Cold load + response: ~10s. Warm: ~3s.

## Security

Game is **public**. No secrets to leak in client state. But:
- Admin REST endpoints (`/api/admin/*`) → localhost-only check in backend
- No raw DB access exposed
- WebSocket read-only (client can't mutate state)
