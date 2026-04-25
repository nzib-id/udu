# Phase 2 — Core Survival Loop

**Goal:** Karakter spawn, jalan, makan, minum. Stats decay jalan. Basic Utility AI bikin karakter "alive" — lo bisa nonton dia survive independently via forage.

**Estimate:** ~3-4 hours

**Prerequisites:** Phase 1 complete

## Tasks

### Character spawn

- [x] Backend: on boot, check character DB — if none, spawn new one at center of map
- [x] Persist character state to SQLite tiap N ticks (every 20 ticks = 10s real via `CHARACTER_CONFIG.persistEveryTicks`)
- [x] Frontend: render character sprite (10 sprites preloaded, animations defined)
- [x] Character position syncs via WebSocket (`state_update` includes `character`; MapScene tweens position on delta)

### Stat system

- [x] Backend tick loop: tiap game-hour, apply decay rates (hourKey tracked in GameLoop, decay applied on hour rollover)
- [x] Stats stored in character row (persisted via CharacterRepo every 20 ticks)
- [x] Frontend: stat bar panel (hunger/thirst/bladder/energy) live (color-coded ok/warn/crit tiers)
- [x] Lemes state visual (sprite tint 0x8a7a6a kalau hunger/thirst/energy <20)

### Resource seeding

- [x] On first boot, seed resources from MAP_CONFIG:
  - [x] 14 bushes (random berry count 3-5)
  - [x] 9 trees (random fruits 2-3)
  - [x] River path (fixed tiles, 2-wide vertical strip with sine zigzag)
  - (wood tidak seeded on boot — spawn organik dari tree dropping branches, handled di Phase 3)
- [x] Resource state persist ke SQLite (resource_state table)
- [x] Frontend render semua resources as placeholder shapes (ResourceLayer — river=blue tiles, bush=green circle + red berry dots, tree=brown trunk + green canopy + yellow fruit dots)

### Pathfinding

- [x] Implement simple grid A* di backend (`pathfinder.ts` — Manhattan heuristic, multi-goal via adjacent tiles)
- [x] Walk speed: 1 tile / N game-seconds (`AI_CONFIG.ticksPerTile = 2` → 1 tile / 1s real)
- [x] Interpolate position client-side for smooth animation (`CharacterSprite.update` lerps pixels over `TILE_STEP_MS`)

### Forage actions

- [x] `walk_to(target)` — move character to target position (plan.path consumed tile-by-tile di `advanceAI`)
- [x] `eat_berry(bush_id)` — karakter harus di bush position, consume 1 berry, hunger +15 (`executeFinal` + `NUTRITION.hungerPerBerry`)
- [x] `eat_fruit(tree_id)` — same pattern, hunger +25
- [x] `drink(river_spot)` — thirst +30
- [x] `defecate()` — bladder → 0, at random spot not near water (min Manhattan dist 2 dari river di `planDefecate`)
- [x] Actions logged to `event` table (`EventRepo.log` + `logEvent` wrapper; start + completion events)

### Utility AI v1

- [x] Action enumeration: list all valid actions based on state (urgency map per need di `decide`)
- [x] Scoring function (urgency-based: 100 - stat, bladder inverted; nearest target via path length)
- [x] Decision tick: 1 Hz (`decideEveryTicks: 2` × `tickMs: 500` = 1s real)
- [x] NO learned rules yet (those come in Phase 4)
- [ ] Tie-breaking: prefer lower urgency (save high-urgency for emergencies) — currently picks max urgency above threshold, TODO refine

### Resource regen

- [x] Bush berries: +1 tiap game-day, max 5 (`REGEN_CONFIG` + `applyDailyRegen()` di game-loop)
- [x] Tree fruits: +1 tiap 3 game-days, max 3 (day % 3 === 0 cycle, logged as `resource_regen` event)
- [ ] (Wood handled di Phase 3 — ranting dropped dari tree)

### Frontend visual

- [x] Walking animation (sprite sheet `man_walk` 4 frames @ 8fps, plays on `walk_to`/`wander` via `CharacterSprite.animFor`)
- [x] Current action text di UI panel (HUD `#hud-char` nampilin `character.currentAction.type`)
- [x] Time display (HUD `#hud-time` = `day N, HH:MM`)

### Verify

- [ ] Karakter bisa survive 1 game-day (24 min) tanpa intervensi
- [ ] Karakter alternate antara bush, tree, river based on stat urgency
- [ ] Stats reasonable (tidak collapse terlalu cepat, tidak chill banget)
- [ ] Event log shows consistent action stream
