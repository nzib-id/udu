# Phase 2 — Core Survival Loop

**Goal:** Karakter spawn, jalan, makan, minum. Stats decay jalan. Basic Utility AI bikin karakter "alive" — lo bisa nonton dia survive independently via forage.

**Estimate:** ~3-4 hours

**Prerequisites:** Phase 1 complete

## Tasks

### Character spawn

- [ ] Backend: on boot, check character DB — if none, spawn new one at center of map
- [ ] Persist character state to SQLite tiap N ticks
- [ ] Frontend: render character sprite (use placeholder PNG if Nzib belum supply)
- [ ] Character position syncs via WebSocket

### Stat system

- [ ] Backend tick loop: tiap game-hour, apply decay rates
- [ ] Stats stored in character row
- [ ] Frontend: stat bar panel (hunger/thirst/bladder/energy) live
- [ ] Lemes state visual (tint / slower animation kalau hunger<20)

### Resource seeding

- [ ] On first boot, seed resources from MAP_CONFIG:
  - N bushes (dengan random berry count 3-5)
  - M trees (dengan fruits 2-3)
  - River path (fixed tiles)
  - K wood spawns (respawn every X hours)
- [ ] Resource state persist ke SQLite
- [ ] Frontend render semua resources as tile sprites

### Pathfinding

- [ ] Implement simple grid A* di backend
- [ ] Walk speed: 1 tile / N game-seconds
- [ ] Interpolate position client-side for smooth animation

### Forage actions

- [ ] `walk_to(target)` — move character to target position
- [ ] `eat_berry(bush_id)` — karakter harus di bush position, consume 1 berry, hunger +15
- [ ] `eat_fruit(tree_id)` — same pattern, hunger +25
- [ ] `drink(river_spot)` — thirst +30
- [ ] `defecate()` — bladder → 0, at random spot not near water
- [ ] Actions logged to `event` table

### Utility AI v1

- [ ] Action enumeration: list all valid actions based on state
- [ ] Scoring function (baseUtility + urgency + proximity)
- [ ] Decision tick: 1 Hz (tiap 1 detik real)
- [ ] NO learned rules yet (those come in Phase 4)
- [ ] Tie-breaking: prefer lower urgency (save high-urgency for emergencies)

### Resource regen

- [ ] Bush berries: +1 tiap game-day, max 5
- [ ] Tree fruits: +1 tiap 3 game-days, max 3
- [ ] Wood: respawn di random spots tiap ... TBD

### Frontend visual

- [ ] Walking animation (if sprite sheet available, else just position update)
- [ ] Current action text di UI panel
- [ ] Time display (Day N, HH:MM)

### Verify

- [ ] Karakter bisa survive 1 game-day (24 min) tanpa intervensi
- [ ] Karakter alternate antara bush, tree, river based on stat urgency
- [ ] Stats reasonable (tidak collapse terlalu cepat, tidak chill banget)
- [ ] Event log shows consistent action stream
