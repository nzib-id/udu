# Tech Stack

## Overview

```
┌──────────────────────────────────────────────────────────────┐
│                    Browser (client)                           │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Phaser 3 + TypeScript                                 │  │
│  │  - Render map + karakter + UI                          │  │
│  │  - Receive state via WebSocket                         │  │
│  │  - View-only (no simulation di client)                 │  │
│  └────────────────────────────────────────────────────────┘  │
└───────────────────────┬──────────────────────────────────────┘
                        │ wss://udu.loodee.art/ws
                        │ (state push, ~500ms-1s throttle)
                        ▼
┌──────────────────────────────────────────────────────────────┐
│              Node.js Backend (Docker container)               │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Simulation Engine                                     │  │
│  │  - Game loop (tick ~500ms)                             │  │
│  │  - Utility AI (action scoring)                         │  │
│  │  - Stat decay, resource regen                          │  │
│  │  - Event logger                                        │  │
│  └───────────────────┬────────────────────────────────────┘  │
│                      │                                        │
│  ┌───────────────────▼────────────────────────────────────┐  │
│  │  Reflection Engine                                     │  │
│  │  - Triggered tiap game-day                             │  │
│  │  - Call Ollama qwen3:8b, parse JSON rules              │  │
│  │  - Merge rules ke utility weights                      │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  SQLite (data/udu.db)                                  │  │
│  │  - rules, events, character_state, lineage             │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────┬───────────────────────────────────────┘
                       │ HTTP
                       ▼
┌──────────────────────────────────────────────────────────────┐
│  Ollama (Windows host @ 172.21.160.1:11434)                   │
│  Model: qwen3:8b (GPU inference, ~20 tok/s)                   │
│  Prompt suffix: /no_think untuk skip reasoning phase          │
└──────────────────────────────────────────────────────────────┘
```

## Frontend

| Component | Choice | Version |
|-----------|--------|---------|
| Engine | **Phaser 3** | latest stable |
| Language | TypeScript | latest |
| Bundler | Vite | latest |
| Canvas | WebGL (Phaser default) | - |
| Asset format | PNG (16x16 sprites) | - |

**Reasoning:** Phaser 3 pure-code, no editor GUI — ideal buat AI agent build end-to-end. Asset loading simpel (drop PNG, `this.load.image()`).

## Backend

| Component | Choice | Version |
|-----------|--------|---------|
| Runtime | **Node.js** | 22.x |
| Language | TypeScript | latest |
| WebSocket | `ws` package | ^8.x |
| Process manager | Docker Compose | multi-stage build, `node:22-bookworm-slim` + `tsx` runtime |
| DB | **better-sqlite3** | ^11.x (sync API, ideal untuk game loop) |
| HTTP (optional) | Fastify atau raw `http` | TBD |

## LLM

- **Ollama** di Windows host (172.21.160.1:11434)
- Model: `qwen3:8b` (5.2 GB, Q4_K_M, ~20 tok/s GPU inference)
- Endpoint: `POST /api/generate`
- Prompt suffix: `/no_think` wajib biar skip thinking phase
- Cold load: 7s, stays hot 5 min
- Call frequency: **~1 call / 24 min real** (tiap game-day) → praktis zero cost, zero rate limit

## Documentation

- **VitePress** (static site generator, MIT)
- Deployed to `udu-docs.loodee.art`
- Build dilakukan di dalam Docker image (`docs/Dockerfile` stage 1 `vitepress build` → stage 2 `nginx:alpine`). Rebuild via `docker compose build docs && docker compose up -d docs`.

## Infrastructure

- **Docker Compose** untuk backend + frontend + docs (3 services, bridge network `udu`, volume `./data:/app/data`)
- **cloudflared** tunnel di `~/.cloudflared/config.yml` untuk public HTTPS
- **DNS:** `udu.loodee.art`, `udu-docs.loodee.art`
- **Access:** Public (no CF Access policy) — game bebas ditonton siapa aja

## Ports (internal, localhost)

| Port | Service |
|------|---------|
| 4245 | VitePress docs via `nginx:alpine` (`udu-docs.loodee.art`) |
| 4246 | Udu game frontend static serve (`udu.loodee.art`) |
| 4247 | Udu backend WebSocket + HTTP API (behind frontend reverse proxy / direct WS path) |

## Storage

- **SQLite** di `projects/udu/data/udu.db`
- Game state persist antar restart (tinggal run ulang, karakter lanjut dari posisi terakhir)
- Backup: include-able ke cron backup Loodee Studio (`~/backup-loodee.sh`) — TBD
