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

**Active phase:** **Phase 4.7 Layer 2 COMPLETE (2026-04-25) — Daily Goal + Hybrid AC shipped end-to-end. Debug speed multiplier (1×/2×/3×) also live. Layer 3 (Momentum) + life-goal satisfaction/completion pending.**

- **Goal System Layer 1 (2026-04-25 14:50):** characters now form a long-horizon life goal on spawn, grounded in their current world state. New files: `data/migrations/006_life_goal.sql` (4 cols on `character`), `shared/types.ts` extended with `LifeGoal` type, `backend/src/llm/{world-summary,prompt-life-goal,life-goal}.ts`. World summary aggregates known resources by type, explored/total chunk counts, recent death reasons, inventory, and cached lessons. The LLM emits `{goal, reason, priority 1-10, referenced_entities}` — every entity must appear in the allowed-set or the goal is rejected (one retry, then no-goal fallback). Goal injected into `prompt-wander` + `prompt-feed` as a tie-breaker, *never* overrides survival pressure. HUD chip at `#hud-goal` shows priority badge + reason on hover. **Verified end-to-end:** char id=1 picked *"Explore all unexplored areas to find resources"* (priority 9) — DB row populated, WS `state_update.character.lifeGoal` field present, subsequent wander reasoning literally cites *"aligning with the priority to explore uncharted areas for essential resources"*.



- **Wander annotation enrichment (2026-04-25 14:00):** filled three gaps in the existing wander-LLM layer:
  1. *Bug fix:* prompt-wander promised `near_<type>(age=Xh)` but `annotateWanderTarget` only emitted `near_<type>` (no age) — LLM was being asked to reason about staleness without the data.
  2. *Composition gap:* annotation only reported the nearest single resource. Replaced with grouped counts (`bushx3+tree`) so "1 bush" vs "5 bushes" no longer collapse.
  3. *Curiosity gap:* "unexplored" used to mean "no resource within 4 tiles" — barren chunks the char had circled 10× still read as virgin. Added a real visit log: migration `005_chunk_visit.sql`, `shared/spatial.ts` (5×5 tile chunks → 48 chunks over 40×30 map), `backend/src/chunk-visit-repo.ts`, per-tick `trackChunkVisit` in game-loop (chunk-boundary-gated upsert), wiped on death like `spatial_memory`.
  - New annotation schema: `composition,age=Xh,visited=N|unvisited[,edge]` or `nothing,unvisited|visited=N`. `prompt-wander.ts` system prompt rewritten with heuristics — prefer unvisited when stats healthy, prefer fresh+rich when stats dipping, avoid `nothing,visited=N` (barren revisit).
  - **Verified end-to-end:** post-restart WS tap → char picked `wander_se` with reasoning *"highly fresh resources with diverse composition in an unvisited area nearby"* (LLM literally quotes the new tag vocabulary). DB grew from 1 → 5 chunks tracked over 90s, `visit_count` increments correctly on revisit.

- **Phase 4 (earlier 2026-04-25) — feed-choice LLM + reflection layer both shipped & verified end-to-end.**

- **First contact (11:45):** char makes feed decisions through qwen3:8b Ollama. `backend/src/llm/{ollama-client,prompt-feed,choice-picker}.ts`; `ai.decide`/`planFeed` async + `ChoicePicker`; `game-loop` reads `UDU_AI_MODE` env, fires `decideInFlight` flag. `Character.lastChoice/lastReasoning/lastChoiceAt` broadcast → HUD italic-blue chip.
- **Architecture pivot (afternoon):** stripped mechanic spoilers from prompt (no more "shake_tree drops fruit, pickup after"); replaced with `Observation` ring buffer (cap 10) of `{t, action, target, dHunger, dThirst, dEnergy, dSickness, inv}`. LLM induces cause→effect from its own action history. After ship: char alternated `forage_bush → eat_berry_inv → forage_bush → eat_berry_inv` instead of shake-spam, reasoning quoted observations directly.
- **Reflection layer (evening):** daily LLM cycle synthesizes natural-language rules from event log, persists as spirit memory across deaths.
  - Migration `data/migrations/003_rule_text.sql` adds `text/active/learned_at_day` cols + `idx_rule_lineage_active`.
  - `backend/src/rule-repo.ts` NEW — `loadActive(lineageId)`, `save(lineageId, iter, day, rules)`, `pruneActive` (keep top-10 by confidence).
  - `backend/src/event-repo.ts` — exported `EventRow`, added `loadSince(sinceMs, limit=500)`.
  - `backend/src/llm/{prompt-reflection,reflection}.ts` NEW — frames LLM as "spirit memory of a lineage", emits `{rules:[{text,confidence}], summary}`. Confidence floor 0.4, max 8 rules, 90s timeout, numPredict 600, temp 0.6.
  - `backend/src/game-loop.ts` — daily trigger on game-day boundary via `applyDailyRegen` (`scheduleReflection(endedDay)` fire-and-forget, `reflectionInFlight` guard); `cachedRules` injected into feed prompt as "Lessons from past lives"; `refreshRulesCache()` after reflection + on respawn.
  - `backend/src/server.ts` — admin endpoints `POST /api/admin/reflect-now` and `GET /api/admin/rules`.
  - **Verified end-to-end:** manual `/api/admin/reflect-now` → `{ok:true, rulesAdded:1, summary:"Sleep is essential for survival."}`; logs `[reflection]   • (0.90) Rest is necessary for survival`; DB row populated; subsequent feed pick reasoning quoted the rule literally: "Rest is necessary for survival, but energy is already high. Shaking trees provides sustenance and energy..."
- **Phase 5 Option A** also shipped earlier (2026-04-25): natural death + lifespan + lineage events.
- **Next options:** Phase 5 Option B (HUD iteration counter + "Generation N has passed" banner on lineage_event), or move on to Phase 6 polish.
**Status:** Phase 3 mechanics live; polish pass still uncommitted; new dual-grid tileset system live. Character sprite animations (10 sheets, E/W flip, one-shot bow/shake/swing) wired. Harvest split into `shake_tree` → `fruit_on_ground` → `pickup_fruit_ground` → `eat_fruit`; berry uses `pickup_berry` → `eat_berry`. Chicken AI eats `fruit_on_ground` within 5 tiles. HUD inventory renders items.png icon chips. **Flow verified end-to-end** via puppeteer + WS tap (hunger 5→100 via 4 fruit cycles).

**Responsive camera (2026-04-24, Nzib confirmed on iPhone):** canvas 100% viewport, default zoom targets 15 tiles on shorter axis, follow-by-default + drag-breaks-follow, on-screen `＋ / − / ◎` bottom-left. **Root cause of black-bar-at-bottom:** Phaser camera default `originX/Y=0.5` offsets rendered world upward when zoom is tall-axis-limited. Fix `MapScene.create()` → `cameras.main.setOrigin(0, 0)`. See dev-log 2026-04-24 final section for detail.

**Character sprite v2 (2026-04-25):** all 10 sheets in `frontend/public/sprites/char/` redrawn with proper outline. Cache-buster `?v=2` added to all paths in `CharacterSprite.ts:SPRITE_DEFS` — without it Phaser's preloader can serve stale cached PNGs even after hard-refresh. Lesson: any time sprite content changes without filename change, bump the `?v=N` query string.

**Walk animation sync fix (2026-04-25):** two bugs in `CharacterSprite.ts:update()`:
- *Jalan di tempat:* fixed 500ms lerp on short final-leg steps (e.g. 0.3 tile) made sprite crawl while walk anim ran full speed. Fix: `tweenMs = (stepDist / 1.25) * MOVE_TWEEN_MS`, floored at 100ms. Full step (2.5 t/s × 500ms broadcast = 1.25 tile) keeps 500ms; shorter steps scale down.
- *Animasi stop sebelum sampai:* backend pops final waypoint and flips `currentAction.type` to `idle`/`eat_*` in the SAME tick that broadcasts the final position — frontend then switched to `man_idle` while sprite still had lerp left. Fix: walk anim now keyed off `isMoving = t < 1 && stepDist > 0.02` (visual state), not action label. `animFor()` now returns `man_idle` for `walk_to`/`wander` so the stationary fallback doesn't loop walk-in-place.

**Pixel-perfect zoom (2026-04-25):** zoom non-integer (e.g. 1.4 → 22.4 px/tile) caused jaggies and pixel doubling. Fix in `main.ts` (added explicit `roundPixels: true`) and `MapScene.ts` (new `snapZoomPixelPerfect(z, floor)` helper that snaps zoom to multiples of `1/tileSize = 0.0625`, ceiling to cover-floor when snap-down would re-introduce letterbox). Applied at all 3 zoom-set sites: `zoomAround()`, `fitCamera()`, resize handler. Cover-floor invariant preserved — black-bar regression won't return.

**Liveness pass — action-decay + thresholds + rest + food-energy + circadian (2026-04-25 10:30, Nzib confirmed "gas semua fitur"):** Five mechanics shipped together to make the character feel alive instead of robotic.
- `shared/config.ts` adds `TILE_DECAY` (energy −0.10 / thirst −0.04 / hunger −0.05 per tile walked), `ACTION_COSTS` (shake −2, hunt −3 +3thirst, pickup −0.3, cook −0.5, defecate −0.2), `THRESHOLDS` (hunger/thirst trigger 25, energy 15, bladder 85 — replaces old single `urgencyThreshold`), `REST_CONFIG` (35% probability, 60–180s, decay ×0.3), and `NUTRITION` energy bonuses (berry +1, fruit +2, meat raw +4, cooked +8, drink +0.5). `sleepWakeEnergy` 80 → 90.
- `shared/circadian.ts` NEW — `Phase = morning|afternoon|evening|night`, `currentPhase(hour)`, and `CIRCADIAN` multipliers per stat. Night sleep recovery ×1.8, midday nap ×0.4, energy drain ×1.5 at night, etc.
- `shared/types.ts` adds `'rest'` to `ActionType`.
- `backend/src/game-loop.ts` — `applyHourlyDecay` walks one game-hour at a time so each hour gets ITS phase multiplier (matters across phase boundaries); resting state applies `REST_CONFIG.decayMultiplier`. `advanceAI` tracks `tilesMoved = initialBudget - leftover` per tick and calls new `applyTileDecay`. `executeFinal` adds energy/thirst costs to each action and energy bonuses to eats/drinks. `'rest'` is a continuous action like sleep/cook (installs its own `currentAction`, exits via `restEndsAtMs`). `pendingFinal` reset-to-idle now also exempts `'rest'`.
- `backend/src/ai.ts` — `decide()` uses per-need triggers; when none fire, 35% chance of `planRest` else wander.
- `frontend/src/entities/CharacterSprite.ts` — `'rest'` reuses `man_sit`.
- **Verified live** via WS tap inside `udu-backend`: rest cycle (rest→wander→rest) playing, ~0.1 energy/tile during wander, night-phase damping holds stats steady (×0.5 hunger × ×0.3 rest = ×0.15), hysteresis stops compulsive eating (H=93 above trigger=25, character idle). No DB wipe needed (no terrain/seed change).
- **Tweak (2026-04-25 10:40, "rest mulu"):** flat 35% prob caused ~94% rest time (tiap wander selesai → re-roll → durasi rest 60-180s ≫ wander 3-5s). Replaced `REST_CONFIG.probability` dengan `maxProbability: 0.3`; `ai.decide` compute `restProb = (1 − energy/100) × 0.3`. Energy 100 → 0%, energy 50 → 15%, energy 15 (sleep trigger) → ~25%. Verified: 19 wander : 1 rest in 240 ticks (energy 71→57). Char fresh almost never sits, tired char sits often. Natural.
- **Tweak (2026-04-25 10:55, "rare banget"):** rest masih kerasa dominan, dijadiin event langka. `REST_CONFIG.maxProbability: 0.3 → 0.05`, `minDurationMs/maxDurationMs: 60-180s → 15-30s`, tambah `energyGate: 60` (skip roll kalo energy ≥ 60). Plus need-interrupt di `game-loop.advanceAI`: pas `currentAction === 'rest'`, kalo hunger/thirst <=25 atau energy <=15 atau bladder >=85 → langsung berdiri. Survive > comfort. Verified: energy=70 → 0 rest ticks dlm 120 ticks (gate kerja); energy=14 → cuma 2 rest events dlm 90s, durasi 7.5s + 25.9s (sesuai spec).
- **Tweak (2026-04-25 11:03, "restart pas sunrise"):** server boot dulu start di `hour=0` (tengah malam) → char langsung kena night phase × hard energy decay. Tambah `TIME_CONFIG.startHour: 6` (sunrise pas, awal morning phase). `GameLoop.startMs` di-anchor mundur sejauh `startHour × 60 × realMsPerGameMinute` (= 360_000ms) so `gameTime()` di tick pertama kembali `hour: 6`. Verified: post-restart, snapshot `time: { day: 1, hour: 6, minute: 6 }`. Char start fresh di pagi hari tiap restart.

**Biome system + linear river (2026-04-25 09:30, Nzib confirmed):** `shared/terrain.ts` now generates `BiomeType = 'forest' | 'grove' | 'open'` parallel grid. River replaced from blob (~10% blob) → edge-to-edge linear path: pick entry edge + opposite exit, 3 perturbed waypoints, Bresenham 1-2 tile thick. Biomes blob-grow on grass after dirt: 3 forest zones × 130 tiles, 5 grove zones × 70. `BIOME_CONFIG` in `shared/config.ts` drives per-biome density + barren chance (forest 0.40 tree / 0.80 barren rimbun, grove 0.15 / 0.20 food zone, open 0.02 / 0.04 sparse). Forest tiles skip 1-cell free-neighbor buffer. `RESOURCE_CONFIG.{bushCount,treeCount,bushBarrenChance,treeBarrenChance}` REMOVED, `seed` bumped 1→2. `data/udu.db*` wiped to re-seed (backup at `udu.db.bak-pre-biome-*`). Verified counts: river 55, tree 155, bush 42, chicken 2, fish 2, fire 1. See dev-log 2026-04-25 "Biome system" section.

**Day/night cycle (2026-04-25, Nzib confirmed):** new `frontend/src/entities/DayNightLayer.ts` — fullscreen `Rectangle` overlay following camera viewport, depth `1_000_000` (above tree canopy `10_000`). 10 keyframes across 24 game-hours (deep-night → pre-dawn violet → sunrise orange → morning soft → full day → golden hour → sunset → dusk → back to night). RGB + alpha lerp between keyframes via `sampleAtHour()` using `currentTime.hour + minute/60`. **Overlay leak fix:** overcover by 32 screen-px each side — without margin, camera follow lerp + `roundPixels` left a 1–2px un-tinted edge gap during scroll. Wired in `MapScene` create + update (after pan/follow so it sees final viewport state). State source: `state_update.time` from server.

**Tileset v2 (2026-04-24 16:40 GMT+7):**
- New tileset `192×48 @ 16px` at `frontend/public/sprites/tiles/tileset.png` — cols 0-5 = water overlay (full 16 masks), cols 6-11 = dirt overlay (9 masks, single-corner/diagonal blank by design).
- `shared/terrain.ts` NEW — deterministic seed-based grid generator, blob-grown water/dirt patches, 1-cell buffer water↔dirt.
- `shared/config.ts` — exports `TERRAIN_GRID`, `WATER_TILES`, `DIRT_TILES`. `RESOURCE_CONFIG.riverPath` REMOVED.
- `frontend/src/entities/TerrainLayer.ts` — full rewrite, grass base + dual-grid dirt/water overlays.
- `backend/src/resource-repo.ts` — `riverPath` refs replaced with `WATER_TILES`.
**⚠️ Uncommitted polish changes** (executed without green light — Nzib to keep/rollback):
- `backend/src/pathfinder.ts` 8-way + octile
- `backend/src/game-loop.ts` chicken 8-way wander/flee
- `frontend/src/entities/ResourceLayer.ts` rewritten: per-entity sprites for all resources, ripple-only overlay, y-based depth
- `frontend/src/entities/SpriteRegistry.ts` rewritten: `visualFor()` returns `{sheetKey, frame, anchor, animate}`; loads trees/bushes/fireplace from `/sprites/tiles/`
- `frontend/src/entities/CharacterSprite.ts` y-based depth
- `frontend/src/entities/TerrainLayer.ts` new — auto-tile terrain + scatter decoration (seed 42)
- `frontend/src/scenes/MapScene.ts` preload hooks + TerrainLayer wired
**Rollback command:** `git restore projects/udu/backend/src/pathfinder.ts projects/udu/backend/src/game-loop.ts projects/udu/frontend/src/entities/ResourceLayer.ts projects/udu/frontend/src/entities/CharacterSprite.ts projects/udu/frontend/src/scenes/MapScene.ts && rm projects/udu/frontend/src/entities/SpriteRegistry.ts projects/udu/frontend/src/entities/TerrainLayer.ts`
**See:** `docs/dev-log/2026-04-24.md` bottom section + `docs/tasks/phase-3-hunting.md`

**Recently completed:**
- ✅ Phase 0 — Documentation (2026-04-23)
- ✅ Phase 1 — Foundation (2026-04-24): skeleton end-to-end — Phaser grid 80x60, WS state_update @1Hz, SQLite schema v1, Docker Compose, DNS wired.
- ✅ Phase 2 prep (2026-04-24): 10 character sprites manual-draw di `frontend/public/sprites/char/`.
- ✅ Phase 2 (2026-04-24): A* pathfinding, forage actions, Utility AI v1, resource regen, HUD.
- ✅ Phase 3 (2026-04-24): hunting + cooking + fire + wood + sickness (full mechanic).

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
| Deploy | Docker Compose + cloudflared tunnel, public (no CF Access) |

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
| Deployment | `docs/guide/deployment.md` | Docker Compose, cloudflared, DNS |
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
- Docker status: `docker compose ps` (di `/home/nzib/.openclaw/workspace/projects/udu/`)
- Docker logs: `docker compose logs -f backend` (or `frontend` / `docs`)
- cloudflared config: `~/.cloudflared/config.yml`
