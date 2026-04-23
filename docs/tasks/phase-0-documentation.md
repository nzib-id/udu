# Phase 0 — Documentation

**Goal:** Well-documented project dari awal. Any future session bisa onboard dengan baca docs, gak perlu brief ulang.

**Estimate:** ~30-45 minutes

**Status:** ✅ Complete (2026-04-23)

## Tasks

### Setup

- [x] Create `projects/udu/` directory
- [x] `npm init -y` + install VitePress as devDependency
- [x] Create docs folder structure (`.vitepress/`, `guide/`, `tasks/`, `dev-log/`, `public/`)
- [x] Write `.vitepress/config.ts` (nav, sidebar, theme)

### Guide (spec docs)

- [x] `guide/vision.md` — filosofi, goals, non-goals, success criteria
- [x] `guide/stack.md` — tech stack + arsitektur diagram
- [x] `guide/gameplay.md` — mechanics: stats, resources, hunting, death
- [x] `guide/ai-architecture.md` — Utility AI + LLM reflection engine detail
- [x] `guide/data-model.md` — SQLite schema + TypeScript types
- [x] `guide/api.md` — WebSocket protocol + REST endpoints
- [x] `guide/deployment.md` — pm2, cloudflared, DNS, build flow
- [x] `guide/sprites.md` — sprite spec Nzib harus supply

### Tasks (phase checklists)

- [x] `tasks/index.md` — overview + status table
- [x] `tasks/phase-0-documentation.md` — this file
- [x] `tasks/phase-1-foundation.md`
- [x] `tasks/phase-2-survival.md`
- [x] `tasks/phase-3-hunting.md`
- [x] `tasks/phase-4-learning.md`
- [x] `tasks/phase-5-death.md`
- [x] `tasks/phase-6-polish.md`

### Dev log

- [x] `dev-log/index.md`
- [x] `dev-log/2026-04-23.md` — planning session + docs init

### Session context

- [x] Root `SESSION_CONTEXT.md` (file-read access for fast onboard)
- [x] `docs/context.md` (web-accessible mirror via udu-docs.loodee.art)

### Git + deploy

- [x] Create `.gitignore` (node_modules, data/, logs/, dist/)
- [x] Create root `README.md` (quick start + onboard pointer)
- [x] `git init` + first commit
- [x] Create GitHub repo `nzib-id/udu` via `gh repo create`
- [x] Push to GitHub

### VitePress deploy

- [x] Build VitePress (`npx vitepress build docs`)
- [x] Setup `npx serve` via pm2 pada port 4245 (pm2 process name: `udu-docs`)
- [x] Add `udu-docs.loodee.art` to cloudflared ingress config (pivoted from `docs.udu.loodee.art` — 2-level subdomain outside Cloudflare Universal SSL coverage)
- [x] Reload cloudflared (via `pm2 restart cloudflare-tunnel`)
- [x] Verify `udu-docs.loodee.art` loads (SSL ✅, serves VitePress content ✅)

### Known followups (not blocking Phase 1)

- [ ] CF Access bypass policy untuk `udu-docs.loodee.art` + `udu.loodee.art` (manual di CF Zero Trust dashboard — Nzib action)
- [ ] Add `udu/data/*.db` to `~/backup-loodee.sh` cron include path (saat DB udah exist di Phase 1+)

### Cleanup

- [x] Save docs URL to project memory
- [x] Move to Phase 1

## Outcome

- Repo: https://github.com/nzib-id/udu
- Docs live: https://udu-docs.loodee.art (behind CF Access until bypass policy added)
- Docs source: all spec locked di `docs/guide/`, phase checklists di `docs/tasks/`, dev log di `docs/dev-log/`
- Onboarding: `SESSION_CONTEXT.md` di root = fast file-read for Loodee sessions
- pm2 process: `udu-docs` (port 4245, stays alive via `pm2 save`)
- Cloudflared ingress: updated di `~/.cloudflared/config.yml`
