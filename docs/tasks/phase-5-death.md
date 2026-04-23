# Phase 5 — Death & Spirit Memory

**Goal:** Karakter bisa mati, karakter baru spawn dengan **inherit rules**, UI shows lineage.

**Estimate:** ~1 hour

**Prerequisites:** Phase 4 complete

## Tasks

### Death condition

- [ ] Backend track: jika `hunger == 0` atau `thirst == 0` terus-menerus selama **6 game-hours** (6 min real), karakter dies
- [ ] Death event logged dengan reason: `starvation` atau `dehydration`
- [ ] Record `lifespan_game_hours`, `death_age`, `final_rules_count`

### Respawn logic

- [ ] On death:
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

- [ ] `lineage.current_iteration` incremented on each respawn
- [ ] `character.iteration` matches the lineage iteration at spawn time
- [ ] API `GET /api/status` includes current iteration

### UI additions

- [ ] Frontend display "Iteration #N" in header
- [ ] On death/respawn event, show banner: "Generation 3 has passed. Generation 4 inherits N rules."
- [ ] Reflection log shows inheritance tags (e.g. "[Inherited from Gen 1] berry_red beracun")

### Admin debug

- [ ] `POST /api/admin/kill` — instantly kill current character (triggers respawn with inheritance)
- [ ] Useful untuk test spirit memory tanpa nunggu natural death

### Verify

- [ ] Kill character via admin endpoint
- [ ] Verify new character spawns within 3 seconds
- [ ] Verify all rules from previous generation applied
- [ ] Check utility scoring: new character should AVOID known-bad actions from start (e.g. skip berry_red)
- [ ] Reflection history preserved across generations
- [ ] UI shows correct lineage counter
