# Fire + Temperature Spec

**Status:** ⏳ Pending implementation. HP funnel (related dependency) shipped 2026-04-25 commit `46475c7`.

**Why this doc exists:** spec was finalized in conversation 2026-04-25 morning, then de-scoped to ship HP-only first (user: *"waduh anjir jadi pusing gini ya"*). Re-surfaced 2026-04-25 evening with calibration pass after user noticed temperature drain numbers conflicted with base decay rates.

---

## Module overview

Three coupled systems shipped together (none make sense alone):

1. **Temperature stat** — per-character body temperature, drifts toward ambient
2. **Fire fuel mechanic** — fire requires wood, runs out, can be unlit
3. **`add_fuel` action** — character can refuel fire from inventory wood

Plus a few sickness updates (bladder funnel, sickness recovery) bundled in.

---

## 1. Temperature stat (per-character, NOT global ambient)

### DB
```sql
ALTER TABLE character ADD COLUMN temperature REAL NOT NULL DEFAULT 25;
```

### Mechanic
- Range 0-40°C (extendable beyond), start 25°C
- Drift 0.3°C/game-minute toward target ambient
- **Phase target ambient (no fire):**
  - Morning: 22°C
  - Afternoon: 30°C
  - Evening: 24°C
  - **Night: 16°C**
- **Fire override (when char in radius 3 AND fire is `lit`):** ambient = 28°C
- **Fire unlit (out of fuel):** no override → ambient follows phase

### Why per-char (not global)
1. **Lag/inertia** — char doesn't instant-freeze when night falls; body temp catches up gradually. Running to fire when starting to cool still saves the situation. Realistic + gives strategic room.
2. **Future-proof multi-char** — different chars can have different body temp (one sleeps near fire, one outside).
3. **Hypothermia/fever semantic** — stat is "body condition", not "air here right now". LLM can reason "I'm cold (12°C body)" regardless of current location.

### Storage
`character.temperature` persisted. Ambient NOT stored — recomputed per tick.

---

## 2. Temperature → drive drain (RECALIBRATED)

**Original spec drain rates were too aggressive** (cold mild adding +1 hunger/h vs base 0.1/h = 11x base, cold extreme = 51x base). Recalibrated to 2-5x base to keep cold punishing without overshadowing baseline starvation/dehydration mechanics.

| Range body temp | Energy add/h | Hunger add/h | Thirst add/h | Time-to-impact estimate |
|---|---|---|---|---|
| 20-30 (comfort) | 0 | 0 | 0 | none |
| 10-20 (cold mild) | +0.5 | +0.2 | — | gradual, multi-day window |
| <10 (cold severe) | +2 | +1 | — | ~3 game-day urgency |
| <0 (cold extreme) | +5 | +2 | — | ~1.5 game-day immediate threat |
| 30-40 (hot mild) | — | — | +1 | thirst 2.4/h → ~1.7 game-day |
| >40 (hot severe) | — | — | +3 | thirst 4.4/h → ~22 game-h ≈ 1 game-day |

### Why drain DRIVES not direct HP
- Pipeline gradual: char "feels cold → exhausts → starves → dies", not instant freeze
- Player/AI gets multiple chances to respond (fire, wood, food)
- Realistic physiology: cold burns calories (hunger) + tires body (energy), hot causes dehydration (thirst)

HP only drains when DRIVES hit 0 (existing HEALTH_CONFIG, shipped). So temperature is upstream cause, HP is downstream consequence.

### Sleep modifier (NEW, added during calibration)
- Sleeping anywhere: temperature drain × **0.5** (body metabolism slows)
- Sleeping in fire radius (3 tiles) AND fire is `lit`: drain × **0** (full immunity)
- Sleeping in fire radius BUT fire is `unlit`: drain × 0.5 (sleep modifier only — fuel matters!)

Why fuel matters even when sleeping near fire pit: makes refueling a real stake. Lalai = char freezes overnight regardless of "near fire pit" position.

---

## 3. Fire fuel mechanic

### Resource state JSON
```ts
{ fuel: number, lit: boolean }  // initial { fuel: 24, lit: true }
```

### Mechanic
- **Init: 24 wood one-time spawn** (free, no auto-refill)
- Burn rate: 1 wood / game-hour (only while `lit`)
- Out of fuel → `lit: false` → no warmth override, no cooking
- **Persistent across char respawn** — fire pit and fuel state survive char death. New generation inherits ancestor's fuel state (can be empty if ancestor was lazy).

### Wood respawn (open question — defer?)
Tree drop wood every X game-day? Or strict scarcity (24 init only)?
**Decision needed before implementation.** Default proposal: tree drops 1 wood every 12 game-hour (matches existing `WOOD_CONFIG.dropEveryGameHours`).

---

## 4. `add_fuel` action

| Pre-cond | Within fire radius 1, inventory has ≥1 wood |
| Effect | -1 wood (inv), fire.fuel +1 (max 24), re-lit if previously unlit |
| Cost | -0.5 energy (cheap, not heavy) |

---

## 5. Sickness updates (bundled in this drop)

### New source: bladder=100 → sickness drain
- `bladder = 100` → **+5 sickness/game-hour**
- Funnels bladder pressure through sickness instead of direct HP
- Char "feels sick first" before drives spiral

### New recovery
- sickness `-2/game-hour` if `bladder < 70` AND no raw meat in system
- Without recovery rule, sickness only goes up — char permanently sick once exposed

### Threshold to HP (already shipped)
- sickness ≥80 → HP -10/game-hour (HEALTH_CONFIG)

---

## 6. Frontend changes

### HUD bars (now 6, adding 1 → 7 total)
- hunger, thirst, bladder, energy ✅ existing
- HP ✅ shipped
- **temperature** ⏳ new — gradient render: blue (cold) → green (comfort 25°C marker) → yellow (hot)

### Fire sprite swap
- `fire_lit` (existing animated) — use when `lit: true`
- `fire_unlit` (new asset needed) — gray/dim, no flicker — use when `lit: false`
- Cache-buster: bump `?v=N` per memory `project_udu_sprite_cache_buster.md`

### Fire HUD chip (optional polish)
- Pojok screen `🔥 18/24` (current/max fuel)
- Defer to Module 1.5 if shipping minimal first

---

## 7. LLM prompt updates

### `prompt-feed.ts`
- State summary: `Temperature: 16°C (cold)` (label ranged: comfort/cold_mild/cold_severe/cold_extreme/hot_mild/hot_severe)
- World summary: `Fire: 12/24 wood, lit` or `Fire: 0/24 wood, unlit`
- Action list: include `add_fuel` when char near fire and has wood

### `prompt-wander.ts`
- Annotation tag: `near_fire(lit, fuel=12)` or `near_fire(unlit)` so LLM aware of fuel state

---

## 8. Implementation order

1. Migration `009_temperature.sql` + types + `TEMPERATURE_CONFIG` block
2. Backend: temperature drift logic in `applyHourlyDecay`
3. Backend: temperature → drive drain (tier match per game-hour)
4. Backend: sleep + fire-radius modifier
5. Backend: bladder=100 → sickness funnel + sickness recovery
6. Backend: fire fuel state + burn loop
7. Backend: `add_fuel` action handler + AI awareness (executeFinal + ai.ts decide)
8. Frontend: HUD bar 7 (temperature) + gradient render
9. Frontend: fire sprite lit/unlit swap
10. LLM prompts: temperature + fuel state injection
11. E2E test: docker rebuild, WS tap, observe behavior

---

## 9. Open questions

| Question | Status |
|---|---|
| Wood respawn (tree drop X/day vs strict scarcity) | **DECISION NEEDED** before impl |
| Fire HUD chip ship now or polish? | Defer to 1.5 unless trivial |
| Hot zone: how does char enter hot tier? Map biome? Or just summer/season? | **Future**: requires biome or season system. Not blocking; spec future-proof |

---

## 10. Risk / mitigations

- **Multi-source drain stacking** — bladder=100 (+5 sickness) + cold severe (+1 hunger, +2 energy) + sickness ≥80 (-10 HP) compound fast. Acceptable: it's *supposed* to be lethal at the multi-failure level. HP shipped already with this expectation.
- **Existing characters in DB** — migration `DEFAULT 25` ensures safe baseline. Old saves auto-upgrade.
- **Sickness recovery -2/h tune** — placeholder, may need adjust after observation.
- **LLM coherence under cold** — without temperature in prompt, LLM might misattribute drives draining to hunger/exhaustion instead of cold. Section 7 mitigates by injecting Temperature state.
- **Fire unlit mid-sleep** — char sleeping near fire when fuel runs out → drain re-engages mid-sleep. Could trigger drive crash overnight. Mitigation: night fuel burn rate already 1/h, so 24 wood = ~24 game-hour buffer = full game-day. Realistic stake without instakill.

---

## 11. Decisions locked (2026-04-25)

- Temperature is per-character, not global
- Drain to drives, not direct HP (indirect pipeline)
- Recalibrated drain rates (table in section 2)
- Sleep + fire-radius + lit = full immunity (Option B over Option A)
- Wood init: 24 free spawn, no auto-refill in MVP
- HP shipped first, this spec layered on top
