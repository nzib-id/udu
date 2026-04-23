# SESSION_CONTEXT

**For Loodee:** Baca file ini PERTAMA tiap session baru yang masuk ke Udu project. Ini satu-satunya file yang gue butuhin buat langsung nyambung konteks.

## Project

**Name:** Udu — Tribal Survival AI Sim
**Domain:** https://udu.loodee.art (game), https://udu-docs.loodee.art (docs)
**Repo:** https://github.com/nzib-id/udu
**Local path:** `/home/nzib/.openclaw/workspace/projects/udu/`

## Ownership rule

**LOODEE BUILDS THIS END-TO-END.** Project ini override dari rule "Loodee orchestrator-only". Nzib specifically requested Loodee kerjain sendiri. **JANGAN delegate ke Kobo.**

## Current phase

Update this section tiap phase transition.

**Active phase:** Phase 0 — Documentation
**Status:** In Progress (started 2026-04-23)
**See:** `docs/tasks/phase-0-documentation.md` untuk granular checklist

## What's locked (MVP spec)

| Aspect | Decision |
|--------|----------|
| Gameplay | 1 character observation, autonomous survival, spirit memory across deaths |
| Stack | Phaser 3 + TypeScript frontend, Node.js + better-sqlite3 + ws backend |
| LLM | Ollama `qwen3:8b` at 172.21.160.1:11434 (Windows host), needs `/no_think` suffix |
| Map | 80x60 tiles (16px/tile), camera zoom 2-3x, responsive |
| Time | 1 min real = 1 game-hour; 24 min = 1 game-day |
| Stats | hunger, thirst, bladder, energy (4 core) |
| Resources | Forage (berry, fruit, water) + hunting (ayam, ikan) + kayu tool (no durability) + api unggun |
| Cook | Hybrid: raw = less hunger + sickness, cooked = full hunger, safe |
| Death | 6 game-hours at stat=0 → respawn, rules inherit (spirit memory) |
| AI | Utility AI (real-time) + LLM reflection (daily), rules merged ke weights |
| UI | Minimal — stats panel, action, time, reflection log, event log. No speed control. |
| Deploy | pm2 + cloudflared tunnel, public (no CF Access) |

**Full spec:** `docs/guide/*.md`

## Key documents

| Doc | Path | Purpose |
|-----|------|---------|
| Vision | `docs/guide/vision.md` | WHY we're building this |
| Tech Stack | `docs/guide/stack.md` | Architecture + dependencies |
| Gameplay | `docs/guide/gameplay.md` | Mechanics detail |
| AI Arch | `docs/guide/ai-architecture.md` | Utility AI + LLM engine spec |
| Data Model | `docs/guide/data-model.md` | SQLite schema + TS types |
| API | `docs/guide/api.md` | WebSocket + REST protocol |
| Deployment | `docs/guide/deployment.md` | pm2, cloudflared, DNS |
| Sprites | `docs/guide/sprites.md` | Sprite files Nzib needs to supply |
| Tasks (all phases) | `docs/tasks/phase-*.md` | Granular checklists |
| Dev log (daily) | `docs/dev-log/YYYY-MM-DD.md` | Session-by-session notes |

## How to resume work

1. Baca file ini (SESSION_CONTEXT.md)
2. Baca `docs/dev-log/` latest entry untuk context session terakhir
3. Baca `docs/tasks/phase-<active>.md` untuk current checklist
4. Resume pada task yang masih `[ ]` unchecked

## How to update this file

Tiap **phase transition**, update:
- `Active phase` section
- Tambah phase completion ke "What's done" (future section)

Tiap **session significant decision** yang mengubah spec, update "What's locked" + write full detail di dev log.

## Memory references

Loodee memory (di `~/.claude/projects/-home-nzib--openclaw-workspace/memory/`):
- `project_udu_game.md` — overall project memory (topic: project)
- `project_udu_loodee_owns.md` — ownership override rule

## Quick links

- Game (once live): https://udu.loodee.art
- Docs (once live): https://udu-docs.loodee.art
- GitHub: https://github.com/nzib-id/udu
- Ollama: http://172.21.160.1:11434 (check from WSL)
- pm2 status: `pm2 status` (look for `udu-*`)
- cloudflared config: `~/.cloudflared/config.yml`
