# Phase 3 — Hunting & Cooking

**Goal:** Protein loop — ayam hutan + ikan bisa di-hunt dengan kayu, meat bisa cooked di api unggun, hybrid cook mechanic (raw+sickness vs cooked+safe).

**Estimate:** ~2-3 hours

**Prerequisites:** Phase 2 complete

## Tasks

### Animal spawns

- [ ] Ayam hutan: spawn 2-3 di map, wander behavior (random walk, slow)
- [ ] Flee response: if character within 3 tiles, ayam moves 5 tiles away (not full flee)
- [ ] Ikan: spawn di 3-5 fixed river spots, stationary, subtle ripple
- [ ] Respawn cycle: tiap N game-hours

### Wood pickup

- [ ] `pickup_wood(wood_id)` action — karakter di wood tile, pick up, add to inventory
- [ ] Wood spawn dari tree: tiap 12 game-hours setiap pohon drop ranting ke random adjacent tile (skip kalau tile occupied)
- [ ] Inventory state visible di UI (show held items)

### Hunt mechanic

- [ ] `hunt(animal_id)` action — karakter in same tile as animal, has wood
- [ ] Ayam: auto-kill (single hit, gak perlu combat rolls)
- [ ] Ikan: same, "mancing" flavor text
- [ ] Drop meat item → add to inventory
- [ ] NO wood durability — kayu tetap di inventory

### Cook mechanic

- [ ] Api unggun: always lit di MVP (skip `fire_unlit` → `fire_lit` transition)
- [ ] `cook_meat(fire_id, meat_id)` — karakter at fire, has raw meat
- [ ] Duration: 5 game-minutes (5 detik real)
- [ ] Transform meat_raw → meat_cooked in inventory
- [ ] Log cook event

### Eat mechanic

- [ ] `eat_meat(meat_id)` — consume from inventory
- [ ] Raw: hunger +30, add temporary sickness effect (will be stored as stat di backend)
- [ ] Cooked: hunger +50, no sickness

### Utility AI extensions

- [ ] Add new actions to scoring: pickup_wood, hunt, cook_meat, eat_meat
- [ ] Hunt urgency: depends on hunger (high) + has_wood (required) + nearby_animal
- [ ] Cook vs eat raw: WITHOUT learned rules, karakter might eat raw if hunger urgent + fire far
- [ ] This sets up Phase 4 learning (karakter belajar cook is better)

### Sickness stat (preview)

- [ ] Store sickness 0-100 di character table
- [ ] Eat raw: sickness +20
- [ ] Sickness decays -5 per game-hour
- [ ] Sickness effect: reduce movement speed, add "sick" visual tint
- [ ] No lethal di MVP (akan re-enable di v1.5)

### Verify

- [ ] Karakter bisa hunt ayam/ikan on its own (Utility AI picks hunt action when appropriate)
- [ ] Sometimes eats raw (urgent hunger), sometimes cooks — both paths happen naturally
- [ ] Event log captures full hunt → cook → eat sequence
- [ ] Sickness stat visible, decay works
