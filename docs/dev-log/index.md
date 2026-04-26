# Dev-log index

Latest first. Read this when scanning across days. For implementation detail (file changes, configs, verify steps), open the specific day file.

## 2026-04-27 — Sprite art swap: tree variants + items + fireplace_off + 1:1 scale rule

- Tree variant sprites: 3 dedicated 96×48 sheets (`tree_fruit`, `tree_vine`, `tree_wood`) replace the shared `trees.png`. Visual differentiation now lives in art, not just data — `tree_fruit` decos preserved.
- `items.png` 3→4 frames: real vine sprite at `[3]`. Retired the placeholder where `vine_on_ground` was a green-tinted berry.
- `fireplace_off.png` dedicated unlit-state sprite. Removed the `tint: 0x444444` hack on the lit frame.
- Pixel scale rule (Nzib correction): `scale: 1` mandatory for every sprite/decoration. Fruit deco 0.75→1, berry deco 0.6→1. Saved as feedback memory.
- Dimensional sanity: ffmpeg `cropdetect` on each new f0/f1 to verify trunk+canopy alignment vs old trees.png anchor.

## 2026-04-26 — Decision-making completeness + Fire+Temp + Day-18 bug-fixes + Night System + Cortex mode + Batch 7 + Cara A + observe.py + escape valve + drop_X + gate removal + cap=20 + Phase A.1 tree split

- Wander/feed annotation completeness pass: every consume option carries `expected=+Nstat`, raw meat dual-tags `+hunger,+sickness`, cooked dual-tags `+hunger,+energy`.
- New pre-emptive maintenance options: `pee_now` (bladder ≥ 50), `warm_at_fire` (body temp < comfortMin AND lit fire reachable).
- Phase 4 design fidelity preserved: tags = facts the LLM cannot derive, heuristics ("skip +0", "raw is risky") left to observation log + reflection.
- E2E sweep tooling: `/api/admin/options` debug endpoint + sweep.sh + WS tap script.
- **Fire+Temp Module 1 base** shipped overnight: migration `009_temperature.sql`, `TEMPERATURE_CONFIG`, `SICKNESS_FUNNEL` (replaces flat decay), `add_fuel` action, fire fuel mechanic, frontend Temp HUD bar + tinted unlit fire.
- **Day-18 bug-fix pass — 6 fixes shipped:**
  - **Bug A:** `THRESHOLDS.hungerTrigger 25 → 35` so `hunger=25.29` no longer falls through to wander.
  - **Bug B:** `pendingChunkVisitedNew` flag fixes daily-goal race when LLM still loading on spawn.
  - **Bug C:** `pickup_wood` pre-emptive wander option when fire unlit + char can carry wood.
  - **Bug D:** `pickWander` `numPredict 100 → 300` to clear qwen3:8b `<think>` truncation.
  - **Bug E:** `drink_river` hard-gated to `thirst < 60` (annotation alone wasn't enough — LLM still spammed it).
  - **Bug F:** `suppressSleepUntilTick = tickCount + 6` after `wakeForNeed` to break sleep⇄idle thrash when HP ≤ 50.
- **Bug 1b** (non-blocking, carried): pre-emptive options vanish under terrain isolation; LLM gets degraded menu without signal.
- **Night System upgrade — 3 sub-upgrades shipped:**
  - **Sub-A (vision):** `VISION_CONFIG.rangeNight 5 → 3`, new `rangeNightNearFire: 8`. Char near a lit fire keeps near-day vision through the night; raw dark = almost blind.
  - **Sub-B (lighting):** new `FireLightLayer.ts` — per-lit-fire warm light pool via additive blend on top of `DayNightLayer`. Visible glow oasis at night.
  - **Sub-C (sleep):** new `CIRCADIAN.energySleepTrigger` per-phase (8/10/18/28). `decide()` signature → options bag with `phase` + `nearLitFire`. New `sleep_now` wander option when night + nearLitFire + energy<60.
  - Pre-existing leak fixed: `pickup_wood` now in `WanderKind` union + rule-fallback exclusion list.
- **Cortex mode — full LLM-driven decisions shipped:**
  - New `prompt-cortex.ts` (Option C hybrid): perceptual stat scale + value-only survival principles, NO mechanic disclosure, observation cap 10 → 30.
  - New `enumerateCortexOptions` (ai.ts) — flat menu of every action: feeds + wander dirs + maintenance (`pee_now`, `warm_at_fire`, `pickup_wood`, `add_fuel`, `rest`) + unconditional `sleep`.
  - New `LlmChoicePicker.pickCortex` (choice-picker.ts) — single LLM call per decide-tick, 30s timeout, falls through to legacy `decide()` on timeout/unparseable/invalid pick.
  - `cortexEnabled` field in `GameLoop`; `/api/admin/cortex` GET/POST toggle endpoint (default ON).
  - Utility AI preserved as dormant fallback (escape hatch — toggle OFF reverts to legacy decide).
  - Verified live: picks landing 2.4–3.4s, coherent reasoning ("Advancing exploration to find resources while maintaining hydration"), no fallbacks observed under normal load.
- **Batch 7 — 7 cortex prompt patches shipped in one rebuild:**
  - **P1 stat polarity:** all three prompts now list stats pressure-first with severity tag inline (`hunger=18 (starving)`).
  - **P2 reasoning-first JSON:** schema flipped so model writes `reasoning` before `choice` — autoregressive decode forces think-before-commit.
  - **P3 observation `failReason`:** `executeFinal` returns perception-level reason on precondition fail (`'bush appears empty'`, `'no fruit fell, tree appears empty'`) — surfaces in next observation block.
  - **P4 Cara A lineage progression:** life-goal LLM diagnoses + prescribes in one call; first-life path produces self-diagnosis from death summary. Migration 010 adds `life_goal_diagnosis`, `chunks_visited_at_death`, `resources_discovered_at_death`.
  - **P5 reflection prompt overhaul:** anti-contamination rewrite — frames as post-day analysis, strips positive example, 3 explicit rule shapes + 5 anti-pattern DON'Ts + confidence anchors.
  - **P6 severity tags:** new `severity.ts` single source of truth, used by all three prompts.
  - **P7 confidence decay + `prior_idx`:** reflection emits `prior_idx` self-tag → `applyConfidenceDecay` boosts confirmed (+0.05), takes LLM conf on refines/new, decays untested (-0.05), drops below 0.40 floor. New `RuleRepo.replaceActive` wipes-and-reinserts active set per cycle.
  - Verified end-to-end: stat-grounded reasoning, severity tags echoed in model output, `failReason` visible, Cara A diagnosis populated post DB reset.
- **DB reset for fresh observation:** stop backend → backup `udu.db` → delete `.db/.db-shm/.db-wal` → migrations 001-010 auto-run on restart → char id=1 spawned at (20,15) with first-life Cara A diagnosis.
- **`scripts/observe.py` — per-run experiment data collector:** pure stdlib Python tails `docker compose logs -f backend`, regex-matches cortex picks + death events, snapshots rules at each death via `/api/admin/rules`, outputs `runs/run-<ts>/{decisions.csv, deaths.csv, rules-by-gen/, summary.txt}`. Args `--until-gen N` (default 3), SIGINT-clean.
- **Escape valve + drop_X + gate removal + cap=20 (night session):**
  - **Escape valve:** `consecutiveCortexFailures` counter in `GameLoop`; at 2 consecutive null `cortexDecide` returns, `buildEscapeWanderResult` forces a random wander direction. Breaks the hallucinated-target infinite loop class. Live: 64 fires logged.
  - **`drop_X` action:** new `'drop'` ActionType + per-item drop option in `enumerateWanderOptions` (annotation `inv=Ncount weight=W drops 1`) + handler that splices inventory + logs event. `WanderKind` template-literal `drop_${string}`.
  - **Stat gates dropped:** `drink_river` (was `thirst<60`), `pee_now` (was `bladder>=50`), `warm_at_fire` (was `temperature<comfortMin`), and `sleep_now`'s `energy<60` clause. Kept physical prereqs (`night && nearLitFire` for sleep_now). Rationale: hidden gates contradict cortex Phase-4 "no mechanic disclosure" — `expected=±Nstat` annotations give the LLM enough to self-skip.
  - **Prompt sync:** removed stale `"energy is below 60"` from `prompt-wander.ts` and the internal `choice-picker.ts` comment.
  - **Inventory cap:** `MAX_INVENTORY_WEIGHT 10 → 20` (B1 rebalance). Wood stays 2.0 — to be replaced by `branch` in Phase A. Char can now carry 10 wood OR mix 5 wood + 10 berry + 5 fruit instead of being wood-locked at 5.
- **Phase A.1 — Tree split + auto-drop foundation (shipped):**
  - `tree` ResourceType split into `tree_fruit | tree_vine | tree_wood` at 50/25/25 spawn ratio. Stash keys `fruits`/`vines`/`branches`.
  - Auto-drop loop every 12 game-hours: each productive tree drops one stashed item to adjacent tile, complementing manual `shake_tree` force-drop.
  - New ground items `branch_on_ground`, `vine_on_ground` + actions `pickup_branch`, `pickup_vine`. `add_fuel` prefers branch over wood (branch weight 0.8 vs wood 2.0).
  - Daily regen split: branch every 1 game-day (sustains 12/7 fire schedule), fruit + vine every 5 days. Caps 2 each.
  - LLM menu: `enumerateWanderOptions` adds `pickup_branch`, `pickup_vine`, `shake_tree_wood`, `shake_tree_vine`. `enumerateFeedOptions`'s `shake_tree` narrowed to `tree_fruit` only.
  - DB reset (no schema migration; type column is TEXT). Verified spawn: 79 fruit / 50 wood / 48 vine of 177 trees, productive 20/16/14, stash keys correct per type.

[→ full 2026-04-26.md](./2026-04-26.md)

## 2026-04-25 — Phase 4 + 4.7 + Phase 5A + HP stat (BIG day)

- **Phase 5 Option A:** natural death (hunger/thirst==0 ≥ 6gh) + lifespan persisted + WS `lineage_event` broadcast for death/respawn.
- **Balance pass:** realistic survival rates + scarce resources (5× scarcer bushes/trees, slower regen, smaller stash).
- **Biome system:** forest/grove/open zones drive per-tile resource density; river replaced with edge-to-edge linear path.
- **Liveness pass** (5 mechanics shipped together): per-tile decay (`TILE_DECAY`), per-action costs (`ACTION_COSTS`), hysteresis triggers (`THRESHOLDS`), rest behaviour (`REST_CONFIG`), food/drink restore energy (`NUTRITION`), circadian rhythm (`shared/circadian.ts`).
- **Phase 4 first contact:** LLM-driven feed choice via Ollama `qwen3:8b`. `Character.lastChoice/lastReasoning` broadcast → HUD italic-blue chip.
- **Architectural pivot:** stripped mechanic spoilers from prompt; replaced with `Observation` ring buffer cap 10 — LLM induces cause→effect from its own action history.
- **Reflection layer (Phase 4 pillar 2):** daily LLM cycle reads event log + prior rules, emits new natural-language rules, persists lineage-scoped (spirit memory across deaths). Injected into feed prompt as "Lessons from past lives".
- **Phase 4.7 Layer 1 (life goal):** spawn-time long-horizon goal grounded in world summary (known resources, explored chunks, recent deaths, inventory, cached lessons). LLM emits `{goal, reason, priority, referenced_entities}` with allowed-set validation.
- **Phase 4.7 Layer 2 (daily goal + hybrid AC):** sub-goal advancement via structured `check` discriminated union (`inventory_has`, `chunk_visited_new`, `action_performed`) + LLM `completes_subgoal` fallback + post-advance re-check (Patch C).
- **Speed multiplier debug:** live 1×/2×/3× toggle via `/api/admin/speed` + floating UI top-right.
- **HP stat (central death funnel):** drives at 0 drain HP, regen when thriving. De-scoped from full Temperature+Fuel — HP first as load-bearing change.
- **Polish:** character sprite v2 (cache-buster `?v=2`), walk anim sync fix (jalan-di-tempat + animasi-stop-sebelum-sampai), pixel-perfect zoom (`snapZoomPixelPerfect`), day/night cycle (`DayNightLayer.ts`, 10 keyframes), wander annotation enrichment (`composition,age=Xh,visited=N`, chunk-visit log).

[→ full 2026-04-25.md](./2026-04-25.md)

## 2026-04-24 — Phase 1 + Phase 2 + Phase 3 (full)

- **Phase 1 Foundation:** Phaser grid 80×60, WS `state_update` @1Hz, SQLite schema v1, Docker Compose, cloudflared DNS wired.
- **Pivot pm2 → Docker** mid-session for parity with deployment.
- **Phase 2 prep:** 10 character sprite sheets manual-draw delivered.
- **Phase 2 Survival:** A* pathfinding, forage actions, Utility AI v1, resource regen, HUD.
- **Phase 3 Hunting:** hunting (chicken, fish), cooking (raw vs cooked), fire, wood mechanic, sickness — full mechanic in same session.
- **Tile system:** dual-grid auto-tile terrain, decoration scatter, y-based depth sorting.
- **Tree/bush/fire sprites** wired from `/sprites/tiles/`.
- **Character animation + multi-stage harvest:** 10 sheets E/W flip, one-shot bow/shake/swing. Harvest split: `shake_tree` → `fruit_on_ground` → `pickup_fruit_ground` → `eat_fruit`.
- **Mobile zoom + HUD toggle.**
- **Responsive camera (iPhone-confirmed):** canvas 100% viewport, 15-tile-on-shorter-axis default zoom, follow-by-default + drag-breaks-follow, on-screen `＋ / − / ◎` controls. Black-bar-at-bottom root cause: Phaser camera default `originX/Y=0.5` — fix `setOrigin(0,0)`.

[→ full 2026-04-24.md](./2026-04-24.md)

## 2026-04-23 — Phase 0 documentation + decision lock

- **Decisions locked:** Phaser 3 + TS frontend, Node + better-sqlite3 + ws backend, Ollama qwen3:8b LLM, 80×60 map, 4 core stats (later expanded to 7), 1-min real = 1-game-hour, hybrid cook (raw vs cooked), spirit memory across deaths.
- **Scope exclusions:** no player control, no combat, no procgen map, no multiplayer, no economy/tech tree, no high graphic fidelity.
- **Project scaffold:** repo init, folder structure, package boundaries.
- **8 guide docs written:** vision, stack, gameplay, ai-architecture, data-model, api, deployment, sprites.
- **VitePress docs site config.**

[→ full 2026-04-23.md](./2026-04-23.md)

## How to maintain this index

Tiap dev-log file baru ditulis (atau update major), tambah/update entry di sini:

1. Headline 1 line: tanggal + theme of the day (max 8 words).
2. 5–12 bullets ringkasan major shipped item — **WHAT** shipped, bukan HOW. Sebut nama config/file/mechanic biar searchable.
3. Link `[→ full YYYY-MM-DD.md](./YYYY-MM-DD.md)` di bawah bullets.
4. Latest entry on top.

**Rule:** kalau bullet butuh > 1 line, itu sinyal detail-nya harus tetap di file harian, bukan di sini. Index = scannable, harian = lengkap.
