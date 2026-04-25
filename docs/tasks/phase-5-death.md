# Phase 5 — Death & Spirit Memory

**Goal:** Karakter bisa mati, karakter baru spawn dengan **inherit rules**, UI shows lineage.

**Estimate:** ~1 hour

**Prerequisites:** Phase 4 complete

## Tasks

### Death condition

- [x] Backend track: jika `hunger == 0` atau `thirst == 0` terus-menerus selama **6 game-hours** (6 min real), karakter dies
- [x] Death event logged dengan reason: `starvation` atau `dehydration`
- [x] Record `lifespan_game_hours` (col added in migration 002, persisted via `recordDeath`). `death_age` deferred — same as lifespan for now. `final_rules_count` deferred until Phase 4.

### Respawn logic

- [x] On death:
  - Mark current character `is_alive = 0`
  - Emit `lineage_event` WebSocket message (death)
  - Wait 3 seconds (dramatic pause)
  - Increment `lineage.current_iteration`
  - Spawn new character at random spot (not near death site)
  - Fresh stats: hunger=100, thirst=100, bladder=0, energy=100
- [ ] Update frontend: fade out dead character, fade in new one

### Rules inheritance (spirit memory)

- [ ] On new character creation:
  - Query all rules where `lineage_id = current_lineage`
  - All rules remain (no filter by confidence for MVP)
  - Rules already tagged with `inherited_from_generation` at original creation time
- [ ] New character IMMEDIATELY applies inherited rules to utility scoring
- [ ] Reflection from new character can ADD new rules OR UPDATE existing (confidence adjust)

### Lineage tracking

- [x] `lineage.current_iteration` incremented on each respawn
- [x] `character.iteration` matches the lineage iteration at spawn time
- [x] API `GET /api/status` includes current iteration

### UI additions

- [ ] Frontend display "Iteration #N" in header
- [ ] On death/respawn event, show banner: "Generation 3 has passed. Generation 4 inherits N rules."
- [ ] Reflection log shows inheritance tags (e.g. "[Inherited from Gen 1] berry_red beracun")

### Admin debug

- [x] `POST /api/admin/kill` — instantly kill current character (triggers respawn with inheritance)
- [x] `POST /api/admin/set-stat` — direct mutate stat (test natural starvation/dehydration without waiting on AI to fail)
- [x] Useful untuk test spirit memory tanpa nunggu natural death

### Verify

- [x] Kill character via admin endpoint (verified: id=4 admin lifespan=0.65gh)
- [x] Verify new character spawns within 3 seconds (verified across iter 2→3→4→5)
- [x] Natural starvation triggers (verified with grace=0.1: id=3 starvation lifespan=17.43gh)
- [x] WS `lineage_event` broadcast for both death + respawn (verified via WS tap)
- [ ] Verify all rules from previous generation applied (Phase 4 dep)
- [ ] Check utility scoring: new character should AVOID known-bad actions from start (Phase 4 dep)
- [ ] Reflection history preserved across generations (Phase 4 dep)
- [ ] UI shows correct lineage counter (frontend HUD work — Option B next)
