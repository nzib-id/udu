# Udu — Tribal Survival AI Sim

> Observasi karakter suku pedalaman yang **belajar sendiri** cara bertahan hidup lewat Utility AI + LLM reflection engine.

**Live (once deployed):**
- Game: https://udu.loodee.art
- Docs: https://udu-docs.loodee.art

## What is this

Mini-world berisi satu karakter primitif yang autonomous. Dia coba survive dengan forage + hunting, tiap malam **refleksi** dengan LLM lokal (Ollama qwen3:8b) yang bikin dia belajar pola. Rules terakumulasi, perilakunya berubah seiring waktu. Kalau mati, karakter baru spawn dengan pengetahuan leluhurnya.

Nzib = observer murni. Tidak ada player control, quest, atau interaksi.

## Stack

- **Frontend:** Phaser 3 + TypeScript (Vite)
- **Backend:** Node.js 22 + TypeScript + better-sqlite3 + ws
- **LLM:** Ollama `qwen3:8b` (lokal, via Windows host 172.21.160.1:11434)
- **Host:** Docker Compose + cloudflared tunnel
- **Docs:** VitePress

## Onboarding for Loodee sessions

**Read `SESSION_CONTEXT.md` first** — single file yang bikin session baru langsung nyambung konteks.

Then navigate to the active phase in `docs/tasks/` dan execute unchecked tasks.

## Development

```bash
# --- Dev (iteration mode, native Node on host) ---
(cd backend && npm install && npm run dev)      # :4247 (ws + api, tsx watch)
(cd frontend && npm install && npm run dev)     # :5173 (Vite proxies /ws + /api → :4247)

# --- Production (Docker, what actually runs on server) ---
docker compose build
docker compose up -d            # backend + frontend + docs
docker compose logs -f backend  # tail
docker compose ps
docker compose down             # stop
```

Ports (localhost only, behind cloudflared):
- `127.0.0.1:4245` → docs (VitePress via nginx:alpine)
- `127.0.0.1:4246` → frontend (Phaser static + `/ws` & `/api` proxy)
- backend runs container-internal at `:4247`, not exposed to host

## Repository structure

```
udu/
├── SESSION_CONTEXT.md      # Read this first
├── README.md               # This file
├── docs/                   # VitePress site (spec + tasks + dev log)
│   ├── .vitepress/
│   ├── guide/              # Project spec
│   ├── tasks/              # Phase checklists
│   └── dev-log/            # Session-by-session notes
├── frontend/               # Phaser 3 + TypeScript (Phase 1+)
├── backend/                # Node simulation engine (Phase 1+)
├── shared/                 # Shared types (Phase 1+)
├── data/                   # SQLite DB (gitignored)
├── logs/                   # local logs (gitignored, mostly unused in Docker)
├── docker-compose.yml     # 3 services: backend, frontend, docs
├── backend/Dockerfile
├── frontend/Dockerfile
└── docs/Dockerfile
```

## License

Personal project. No license.

## Status

- ✅ Phase 0 — Documentation Foundation
- 🟡 Phase 1 — Foundation (in progress)
