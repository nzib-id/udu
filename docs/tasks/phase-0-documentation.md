# Phase 0 — Documentation

**Goal:** Well-documented project dari awal. Any future session bisa onboard dengan baca docs, gak perlu brief ulang.

**Estimate:** ~30-45 minutes

**Status:** 🟡 In Progress (2026-04-23)

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
- [ ] `tasks/phase-1-foundation.md`
- [ ] `tasks/phase-2-survival.md`
- [ ] `tasks/phase-3-hunting.md`
- [ ] `tasks/phase-4-learning.md`
- [ ] `tasks/phase-5-death.md`
- [ ] `tasks/phase-6-polish.md`

### Dev log

- [ ] `dev-log/index.md`
- [ ] `dev-log/2026-04-23.md` — planning session + docs init

### Session context

- [ ] Root `SESSION_CONTEXT.md` (file-read access for fast onboard)
- [ ] `docs/context.md` (web-accessible mirror via docs.udu.loodee.art)

### Git + deploy

- [ ] Create `.gitignore` (node_modules, data/, logs/, dist/)
- [ ] Create root `README.md` (quick start + onboard pointer)
- [ ] `git init` + first commit
- [ ] Create GitHub repo `nzib-id/udu` via `gh repo create`
- [ ] Push to GitHub

### VitePress deploy

- [ ] Build VitePress (`npx vitepress build docs`)
- [ ] Setup `npx serve` via pm2 pada port 4245
- [ ] Add `docs.udu.loodee.art` to cloudflared ingress config
- [ ] Reload cloudflared
- [ ] Verify `docs.udu.loodee.art` loads

### Cleanup

- [ ] Save docs URL to project memory
- [ ] Move to Phase 1
