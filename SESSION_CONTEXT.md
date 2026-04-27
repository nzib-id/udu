# SESSION_CONTEXT

**For Loodee:** baca file ini PERTAMA tiap session masuk Udu. Single-page dashboard. Implementation detail ada di dev-log, bukan di sini.

## Project

- **Name:** Udu — Tribal Survival AI Sim
- **Domain:** https://udu.loodee.art (game), https://udu-docs.loodee.art (docs)
- **Repo:** https://github.com/nzib-id/udu
- **Path:** `/home/nzib/.openclaw/workspace/projects/udu/`

## Ownership rule

**LOODEE BUILDS THIS END-TO-END.** Override dari rule "orchestrator-only" — Nzib specifically requested. **JANGAN delegate ke Kobo.**

## NOW

- **Last shipped (2026-04-27):** **Phase A.2 — Stone/boulder mineable.** New `boulder` (blocking, 3 stone yield then despawn) and `stone_on_ground` (free pickup) resources. Actions `pickup_stone` + `mine_stone` (adjacency-required, 3 energy). Inventory weight `stone:1.5`. Per-biome `boulderDensity` + 8 initial scattered stones — fresh seed yields 19 boulders + 8 stones. LLM wander menu surfaces both options. Sprites delivered (`boulder.png` 32×32, `items.png` bumped to 64×32 with stone at frame 5). Backend+frontend rebuilt clean. Live mine_stone test pending. Also today: sleep-wake loop fix (Opsi A — drop `s.health < max/2` from wake clause; exhaustion-driven HP-low no longer interrupts sleep recovery). Earlier sprite art swap + late-night polish (fish_idle, fireplace glow rewrite). See [dev-log/2026-04-27.md](docs/dev-log/2026-04-27.md).
- **Implemented, awaiting live test (2026-04-26):** **Lineage Progression — Cara A** (diagnose+prescribe pattern in life-goal). Migration 010 + restructured `prompt-life-goal.ts` + `loadLineageTrajectory()` + diagnosis field on `LifeGoal`. Spec & verify checklist: [docs/tasks/lineage-progression.md](docs/tasks/lineage-progression.md). Standalone — NOT part of Batch 7 cortex/reflection patches.
- **Open bugs (non-blocking):**
  - Bug 1b — pre-emptive options vanish under terrain isolation; LLM gets degraded menu without signal. Also blocks fire-light visual verify (current char can't reach fire).
  - Rest spam (utility AI) — `stay → rest` conversion in `wanderWithChoice` lacks energy gate. Cortex bypasses entirely; only relevant if cortex toggled OFF.
- **Strategic frame:** Archetype A (Aquarium Watcher) primary, market test via Loodee content. See [guide/distribution.md](docs/guide/distribution.md).

## NEXT (candidates, awaiting Nzib direction)

1. **Phase 5 Option B** — HUD iteration counter + "Generation N has passed" banner on `lineage_event`.
2. **Bug 1b fix** — surface unreachable known resources to LLM (`warm_at_fire (path=blocked)` style).
3. **Bug 2 fix** — hysteresis or no-op rest fallback when crisis can't be resolved.
4. **Action repertoire** — cook variations, craft, build (universal-valid per distribution strategy).
5. **Lineage display polish** — lineage tree UI, ancestor wisdom timeline.

## Phase status

| Phase | Status | Shipped | Detail |
|-------|--------|---------|--------|
| 0 Documentation | ✅ | 2026-04-23 | scaffold + 8 guides |
| 1 Foundation | ✅ | 2026-04-24 | Phaser grid, WS @1Hz, SQLite, Docker, DNS |
| 2 Survival | ✅ | 2026-04-24 | A* pathfinding, forage, Utility AI v1, regen, HUD |
| 3 Hunting | ✅ | 2026-04-24 | hunting, cooking, fire, wood, sickness |
| 4 LLM choice + reflection | ✅ | 2026-04-25 | feed-LLM, observation log, daily rule synthesis |
| 4.7 Layer 1 (life goal) | ✅ | 2026-04-25 | spawn-time long-horizon goal grounded in world state |
| 4.7 Layer 2 (daily goal + hybrid AC) | ✅ | 2026-04-25 | sub-goal advancement via structured `check` + LLM fallback |
| 5 Option A (natural death) | ✅ | 2026-04-25 | death/lifespan/lineage_event WS broadcast |
| 5 Option B (HUD lineage UI) | ⏳ | — | awaiting GO |
| 6 Polish | ⏳ partial | — | sprite v2, walk anim, pixel-perfect zoom, day/night ✅ |
| HP stat (death funnel) | ✅ | 2026-04-25 | drives at 0 drain HP, regen when thriving |
| Module 1 (Fire fuel + Temperature) | ✅ | 2026-04-26 | base + decision-making completeness E2E verified |
| Phase A.1 (tree split + auto-drop) | ✅ | 2026-04-26 | tree_fruit/vine/wood + branch fuel + ground items |
| Phase A.2 (stone + boulder) | ✅ | 2026-04-27 | mineable boulder, stone inventory item, 19 boulders on map |

## What's locked (MVP spec)

| Aspect | Decision |
|--------|----------|
| Gameplay | 1 character observation, autonomous survival, spirit memory across deaths |
| Stack | Phaser 3 + TS frontend, Node.js + better-sqlite3 + ws backend |
| LLM | Ollama `qwen3:8b` at 172.21.160.1:11434 (Windows host), `/no_think` suffix |
| Map | 80×60 tiles (16px/tile), camera zoom 2–3×, responsive |
| Time | 1 min real = 1 game-hour; 24 min = 1 game-day |
| Stats | hunger, thirst, bladder, energy, sickness, temperature, HP |
| Resources | Forage (berry, fruit, water) + hunting (chicken, fish) + wood + fire |
| Cook | Hybrid: raw = less hunger + sickness, cooked = full hunger, safe |
| Death | HP funnel; drives at 0 drain HP, regen when thriving |
| AI | Utility AI (real-time) + LLM feed/wander + life goal + daily reflection rules |
| UI | Minimal — stats, action, time, reflection log, event log, lineage |
| Deploy | Docker Compose + cloudflared tunnel, public (no CF Access) |

## Doc index

| Doc | Purpose |
|-----|---------|
| [guide/vision.md](docs/guide/vision.md) | WHY we're building |
| [guide/distribution.md](docs/guide/distribution.md) | Archetype A + pivot ladder + market signal |
| [guide/stack.md](docs/guide/stack.md) | Architecture + dependencies |
| [guide/gameplay.md](docs/guide/gameplay.md) | Mechanics detail |
| [guide/ai-architecture.md](docs/guide/ai-architecture.md) | Utility AI + LLM engine spec |
| [guide/data-model.md](docs/guide/data-model.md) | SQLite schema + TS types |
| [guide/api.md](docs/guide/api.md) | WebSocket + REST protocol |
| [guide/deployment.md](docs/guide/deployment.md) | Docker Compose, cloudflared, DNS |
| [guide/sprites.md](docs/guide/sprites.md) | Sprite files needed |
| [design/](docs/design/) | Per-feature spec docs (e.g. fire-temperature) |
| [dev-log/index.md](docs/dev-log/index.md) | **Cross-day scan** — headline + bullet summary per day, latest first |
| [dev-log/](docs/dev-log/) | Per-day implementation log — open specific file kalau butuh detail |
| [tasks/](docs/tasks/) | Per-phase checklists |

## Quick links

- Game: https://udu.loodee.art
- Docs: https://udu-docs.loodee.art
- GitHub: https://github.com/nzib-id/udu
- Ollama: http://172.21.160.1:11434 (check from WSL)
- Docker: `docker compose ps` (di project root)
- Logs: `docker compose logs -f backend`
- cloudflared config: `~/.cloudflared/config.yml`

## Memory pointers

- `project_udu_game.md` — overall topic memory.
- `project_udu_loodee_owns.md` — ownership override.
- `project_udu_distribution_strategy.md` — market positioning + pivot trigger.
- `project_udu_cortex_mode.md` — cortex toggle, design philosophy, revert path.

## How to update this file

- **Phase ship / new module ship:** flip status in phase table, update **NOW** (last shipped + open bugs), refresh **NEXT**.
- **Strategic decision** changing what's locked: update spec table here + write full rationale in [guide/distribution.md](docs/guide/distribution.md) or relevant guide doc.
- **Implementation detail** (file changes, configs, verify steps): write in dev-log harian (`docs/dev-log/YYYY-MM-DD.md`), **never inline in this file.**
- **Dev-log index update:** every time a dev-log file is created or majorly updated, add/update the corresponding entry in [dev-log/index.md](docs/dev-log/index.md) — 1 headline + 5–12 bullets ringkasan. This is what makes cross-day scan possible.

## Resume work flow

1. **Read this file** (SESSION_CONTEXT) — dashboard. Tau Phase X, NOW Y, NEXT Z dalam <30 detik.
2. **Read [dev-log/index.md](docs/dev-log/index.md)** — chronological scan kalau perlu tau "apa yang shipped 2-3 hari lalu" tanpa buka semua file.
3. **Open specific `dev-log/YYYY-MM-DD.md`** — cuma kalau butuh detail implementasi (file changes, configs, verify) untuk fitur spesifik.
4. **Open relevant `tasks/phase-N.md`** — resume on first `[ ]` unchecked item.
