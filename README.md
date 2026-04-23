# Udu — Tribal Survival AI Sim

> Observasi karakter suku pedalaman yang **belajar sendiri** cara bertahan hidup lewat Utility AI + LLM reflection engine.

**Live (once deployed):**
- Game: https://udu.loodee.art
- Docs: https://docs.udu.loodee.art

## What is this

Mini-world berisi satu karakter primitif yang autonomous. Dia coba survive dengan forage + hunting, tiap malam **refleksi** dengan LLM lokal (Ollama qwen3:8b) yang bikin dia belajar pola. Rules terakumulasi, perilakunya berubah seiring waktu. Kalau mati, karakter baru spawn dengan pengetahuan leluhurnya.

Nzib = observer murni. Tidak ada player control, quest, atau interaksi.

## Stack

- **Frontend:** Phaser 3 + TypeScript (Vite)
- **Backend:** Node.js 22 + TypeScript + better-sqlite3 + ws
- **LLM:** Ollama `qwen3:8b` (lokal, via Windows host 172.21.160.1:11434)
- **Host:** pm2 + cloudflared tunnel
- **Docs:** VitePress

## Onboarding for Loodee sessions

**Read `SESSION_CONTEXT.md` first** — single file yang bikin session baru langsung nyambung konteks.

Then navigate to the active phase in `docs/tasks/` dan execute unchecked tasks.

## Development

```bash
# Install deps
npm install
(cd frontend && npm install)
(cd backend && npm install)

# Dev mode (all services)
# TODO: Phase 1 setup

# Docs preview
npx vitepress dev docs

# Build all
npm run build
```

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
├── logs/                   # pm2 logs (gitignored)
└── ecosystem.config.js     # pm2 config
```

## License

Personal project. No license.

## Status

🟡 Phase 0 — Documentation Foundation (in progress)
