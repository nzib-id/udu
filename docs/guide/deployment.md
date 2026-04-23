# Deployment

## Hosting target

- **Server**: Nzib's local server (same as Loodee Studio, Kimai, etc.)
- **Process manager**: pm2
- **Public access**: via cloudflared tunnel → `*.loodee.art` DNS
- **CF Access**: **public** (no auth policy) — anyone with URL can view

## Domains

| Domain | Target | Purpose |
|--------|--------|---------|
| `udu.loodee.art` | localhost:4246 | Game frontend (Phaser) |
| `udu.loodee.art/ws` | localhost:4247/ws | WebSocket endpoint (proxied by frontend server, same origin) |
| `udu.loodee.art/api` | localhost:4247/api | REST admin endpoints |
| `docs.udu.loodee.art` | localhost:4245 | VitePress documentation |

## Ports (internal)

| Port | pm2 name | Service |
|------|----------|---------|
| 4245 | `udu-docs` | VitePress static serve |
| 4246 | `udu-frontend` | Phaser frontend static serve (+ `/ws` & `/api` reverse proxy to 4247) |
| 4247 | `udu-backend` | Node simulation engine + WebSocket + REST |

Backend port 4247 TIDAK exposed via CF tunnel directly — semua traffic masuk via 4246 yang reverse-proxy ke 4247 untuk `/ws` dan `/api`.

## pm2 ecosystem

File: `projects/udu/ecosystem.config.js`

```javascript
module.exports = {
  apps: [
    {
      name: 'udu-backend',
      script: './backend/dist/server.js',
      cwd: '/home/nzib/.openclaw/workspace/projects/udu',
      env: {
        NODE_ENV: 'production',
        PORT: '4247',
        OLLAMA_URL: 'http://172.21.160.1:11434',
        OLLAMA_MODEL: 'qwen3:8b',
        DB_PATH: './data/udu.db',
      },
      max_memory_restart: '500M',
      error_file: './logs/backend-err.log',
      out_file: './logs/backend-out.log',
    },
    {
      name: 'udu-frontend',
      script: 'npx',
      args: 'serve -s frontend/dist -l 4246 --no-port-switching',
      cwd: '/home/nzib/.openclaw/workspace/projects/udu',
    },
    {
      name: 'udu-docs',
      script: 'npx',
      args: 'serve -s docs/.vitepress/dist -l 4245 --no-port-switching',
      cwd: '/home/nzib/.openclaw/workspace/projects/udu',
    },
  ],
}
```

## Cloudflared ingress

Add to `~/.cloudflared/config.yml`:

```yaml
ingress:
  # ... existing entries ...
  - hostname: udu.loodee.art
    service: http://127.0.0.1:4246
  - hostname: docs.udu.loodee.art
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
| CNAME | docs.udu | `<tunnel-uuid>.cfargotunnel.com` | Proxied |

Tunnel UUID: `db112951-567c-439c-880e-3b651de13023` (shared dengan service lain)

Add via:
```bash
cloudflared tunnel route dns <tunnel-id> udu.loodee.art
cloudflared tunnel route dns <tunnel-id> docs.udu.loodee.art
```

## Build & deploy flow

### Backend
```bash
cd backend
npm run build      # tsc → dist/
pm2 restart udu-backend
```

### Frontend
```bash
cd frontend
npm run build      # vite build → dist/
pm2 restart udu-frontend
```

### Docs
```bash
cd docs
npx vitepress build
pm2 restart udu-docs
```

## Initial setup (run once)

```bash
cd /home/nzib/.openclaw/workspace/projects/udu
npm install                           # root deps (shared)
cd frontend && npm install && npm run build && cd ..
cd backend && npm install && npm run build && cd ..
cd docs && npx vitepress build && cd ..
pm2 start ecosystem.config.js
pm2 save
```

## Updates (git pull + redeploy)

```bash
cd /home/nzib/.openclaw/workspace/projects/udu
git pull
(cd backend && npm install && npm run build)
(cd frontend && npm install && npm run build)
(cd docs && npx vitepress build)
pm2 restart udu-backend udu-frontend udu-docs
```

## Backup

- **SQLite DB** (`data/udu.db`) — penting, contains rules + lineage
- **Reflections history** — bagian dari DB
- Include in cron backup (`~/backup-loodee.sh`) — ADD in TODO

## Monitoring

- pm2 logs: `pm2 logs udu-backend --lines 100`
- Health: `curl https://udu.loodee.art/api/status`
- DB size: `ls -lh data/udu.db`
- Ollama connectivity: backend logs warning jika call gagal (fallback: skip reflection that day)

## Troubleshooting

### Backend can't reach Ollama
- Check WSL can reach Windows host: `curl http://172.21.160.1:11434/api/tags`
- If failing: check Windows firewall allows 11434 inbound
- Fallback: backend logs skip, reflection gak jalan hari itu, rules frozen — gameplay tetep jalan

### Frontend shows "connecting..." forever
- Check backend running: `pm2 status udu-backend`
- Check WebSocket endpoint: `wscat -c wss://udu.loodee.art/ws`
- Check reverse proxy config di frontend server

### High Ollama latency
- Check GPU usage on Windows
- qwen3:8b should load once, stay hot 5 min
- Cold load + response: ~10s. Warm: ~3s.

## Security

Game is **public**. No secrets to leak in client state. But:
- Admin REST endpoints (`/api/admin/*`) → localhost-only check in backend
- No raw DB access exposed
- WebSocket read-only (client can't mutate state)
