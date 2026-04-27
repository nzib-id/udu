import type { Action, AiLogEntry, AiLogKind, Character, GameState, GameTime, Position, Resource } from '../../shared/types.js';
import {
  ACTION_COSTS,
  AI_CONFIG,
  ANIMAL_CONFIG,
  CHARACTER_CONFIG,
  DEATH_CONFIG,
  DECAY_RATES,
  DROP_INIT,
  FIRE_CONFIG,
  HEALTH_CONFIG,
  MAP_CONFIG,
  NUTRITION,
  PHYSICS_CONFIG,
  REGEN_CONFIG,
  RESOURCE_TRUTH,
  REST_CONFIG,
  SICKNESS_CONFIG,
  SICKNESS_FUNNEL,
  TEMPERATURE_CONFIG,
  THRESHOLDS,
  TILE_DECAY,
  TIME_CONFIG,
  VISION_CONFIG,
} from '../../shared/config.js';
import { CIRCADIAN, currentPhase } from '../../shared/circadian.js';
import { canCarry } from '../../shared/inventory.js';
import type { CharacterRepo } from './character-repo.js';
import type { ResourceRepo } from './resource-repo.js';
import type { EventRepo } from './event-repo.js';
import type { RuleRepo } from './rule-repo.js';
import type { SpatialMemoryRepo, RememberedResource } from './spatial-memory-repo.js';
import type { ChunkVisitRepo, ChunkVisit } from './chunk-visit-repo.js';
import type { DailyGoalRepo } from './daily-goal-repo.js';
import type { GlossaryRepo } from './glossary-repo.js';
import { tileToChunk, chunkKey } from '../../shared/spatial.js';
import { computeBlocked, cortexDecide, decide, enumerateFeedOptions, enumerateWanderOptions, type ActionPlan, type DecideResult, type WanderHints } from './ai.js';
import {
  LlmChoicePicker,
  RuleBasedChoicePicker,
  type ChoicePicker,
  type Observation,
} from './llm/choice-picker.js';
import { runReflection } from './llm/reflection.js';
import { generateLifeGoal } from './llm/life-goal.js';
import { generateDailyGoal } from './llm/daily-goal.js';
import type { OllamaOptions } from './llm/ollama-client.js';
import { scanVision, visionRangeForHour } from './vision.js';

export type DeathReason = 'starvation' | 'dehydration' | 'exhaustion' | 'illness' | 'exposure' | 'admin';

export type LineageEvent =
  | { event: 'death'; deceasedCharacterId: number; reason: DeathReason; lifespanGameHours: number }
  | { event: 'respawn'; newIteration: number; characterId: number };

export type LineageListener = (e: LineageEvent) => void;

export class GameLoop {
  // Anchor wall-clock so gameTime() returns hour=startHour at server boot.
  // Subtracting startHour worth of real-ms means elapsedRealMs at boot is
  // already that many hours into the game day → opens at sunrise.
  private startMs = Date.now()
    - TIME_CONFIG.startHour * TIME_CONFIG.gameMinutesPerHour * TIME_CONFIG.realMsPerGameMinute;
  // Debug speed multiplier. 1 = normal. Increasing this makes game-time advance
  // faster relative to real-time. setTimeMultiplier rebases startMs so gameTime
  // is continuous across changes (no jumps). Always resets to 1 on restart.
  private timeMultiplier = 1;
  private tickHandle: NodeJS.Timeout | null = null;
  private tickCount = 0;
  private character: Character | null = null;
  private resources: Resource[] = [];
  private blocked: Set<string> = new Set();
  private plan: ActionPlan | null = null;
  private lineageId = 0;
  private lastHourKey = -1;
  private lastDayKey = -1;
  private lastTreeDropHourKey = -1;
  private lastChickenRespawnHourKey = -1;
  private lastFishRespawnHourKey = -1;
  private restEndsAtMs: number | null = null;
  // One-tick-deferred final action. Set when a plan's path empties; on the
  // following tick we run executeFinal and (for non-continuous actions) reset
  // currentAction to idle. Lets the client see the action label in one
  // broadcast window so one-shot anims (man_shake, man_bow, etc.) play.
  private pendingFinal: Action | null = null;
  private nextResourceId = 0;
  // Most-recent dominant cause of HP drain — used as death narration when HP
  // hits 0. Starvation default if HP somehow reaches 0 without recorded cause.
  private lastHpCause: DeathReason = 'starvation';
  private respawnAt: number | null = null;
  private deathPosition: Position | null = null;
  private lineageListener: LineageListener | null = null;
  // LLM call is async (~1.5–3s). decideInFlight blocks subsequent ticks from
  // firing a parallel decide while the previous one is still pending — the
  // character stays idle for those few ticks rather than queueing up calls.
  private decideInFlight = false;
  private picker: ChoicePicker;
  // Action-effect log fed to the LLM so it can induce cause→effect from its own
  // history (shake gave 0 hunger, eat fruit gave +5, etc.) instead of
  // being told the mechanics in the prompt. Reset on death — each generation
  // re-discovers, until reflection persists rules into spirit memory.
  private observations: Observation[] = [];
  // Cached natural-language rules from the reflection cycle. Refreshed on
  // boot, after each reflection completes, and after each respawn (new
  // generation inherits rules). Empty until first reflection lands.
  private cachedRules: string[] = [];
  // Wall-clock ms when the current game-day started — passed to reflection so
  // it can pull just that day's events from the log.
  private currentDayStartMs = Date.now();
  // Set true while a reflection LLM call is in flight; prevents firing a
  // second reflection if the day boundary trips again before the first
  // returns. Day boundaries are 24 min apart, well over reflection budget.
  private reflectionInFlight = false;
  private ollamaOptions: OllamaOptions | null = null;
  // Spatial memory of the live character. Keyed by resource id; persisted to
  // SQLite so a server restart preserves what the character has seen, but
  // wiped on death so each new generation starts blind. Property knowledge
  // (effects of actions) flows through reflection rules, not this map.
  private knownResources: Map<string, RememberedResource> = new Map();
  // Coarse "I've been here" log keyed by chunkKey(cx, cy). Updated whenever the
  // character's tile crosses a chunk boundary so the wander planner can label
  // unexplored vs revisited chunks. Like knownResources, persisted across boot
  // but wiped on death. lastChunkKey gates upserts to once per chunk-entry.
  private chunkVisits: Map<string, ChunkVisit> = new Map();
  private lastChunkKey: string | null = null;
  // Set true while the life-goal LLM call is in flight on a fresh character.
  // Prevents firing a second call before the first lands. Cleared whether the
  // call succeeds, fails, or returns null.
  private lifeGoalInFlight = false;
  // Same-shape guard for the daily-goal LLM call. Fires on day boundary and
  // on init/respawn; if the previous call hasn't returned, the next trigger
  // is dropped silently so Ollama isn't double-hit.
  private dailyGoalInFlight = false;
  private pendingChunkVisitedNew = false;
  // Set when the character is woken early from sleep by a triggered need. For
  // one decide cycle, sleep is suppressed so the waking need gets a chance to
  // be handled before the character immediately re-sleeps (thrash prevention).
  private suppressSleepUntilTick = -1;
  // Cortex mode — when true, every decide() call routes through cortexDecide()
  // which presents the LLM with a flat menu of every possible action and lets
  // it pick freely, bypassing utility-AI urgency triggers. Falls back to legacy
  // decide() on LLM failure or invalid pick. Toggle via /api/admin/cortex.
  private cortexEnabled = true;
  // Pure-LLM escape valve: counts consecutive cortex cycles that returned null
  // (LLM picked an invalid action / timeout / parse fail). At threshold the
  // game-loop forces a random direction wander to change position → change
  // rememberedSummary → break the prompt-repeats-itself loop. Reset on any
  // valid pick. See triggerEscapeWander() for the mechanism.
  private consecutiveCortexFailures = 0;
  private lastVisionTick = -1;
  // Last vision-cone result — exposed via snapshot() so the frontend fog-of-war
  // can render exactly the tiles the LLM perceives. Updated by
  // scanVisionAndUpdateMemory(); empty between scans (every VISION_CONFIG.scanEveryTicks
  // ticks the cone is recomputed). Cleared on respawn so the new character
  // starts with no inherited visibility.
  private lastVisibleTiles: Set<string> = new Set();
  // Cumulative tiles ever inside the vision cone this lifetime — frontend fog
  // uses this to paint "explored but not currently visible" so a mid-life
  // client reconnect shows true accumulated exploration, not a partial trail
  // built from when the WS handshake completed. Cleared on respawn.
  private cumulativeExploredTiles: Set<string> = new Set();
  // Rolling AI debug feed surfaced via state_update so the HUD can render
  // recent decisions, vision discoveries, and lineage transitions. Newest at
  // index 0; capped at AI_LOG_MAX. Cleared on respawn so each new generation
  // starts with a fresh log.
  private aiLog: AiLogEntry[] = [];
  private static readonly AI_LOG_MAX = 100;

  constructor(
    private repo: CharacterRepo,
    private resourceRepo: ResourceRepo,
    private eventRepo: EventRepo,
    private ruleRepo: RuleRepo,
    private spatialRepo: SpatialMemoryRepo,
    private chunkVisitRepo: ChunkVisitRepo,
    private dailyGoalRepo: DailyGoalRepo,
    private glossaryRepo: GlossaryRepo,
  ) {
    this.picker = buildPicker();
    this.ollamaOptions = ollamaOptionsFromEnv();
  }

  init(): void {
    this.lineageId = this.repo.ensureLineage();
    this.resources = this.resourceRepo.seedIfEmpty();
    this.blocked = computeBlocked(this.resources);
    const existing = this.repo.loadActive();
    if (existing) {
      this.character = existing;
      console.log(
        `[game-loop] loaded character id=${existing.id} iter=${existing.iteration} at (${existing.position.x},${existing.position.y})`,
      );
    } else {
      this.character = this.repo.spawn(this.lineageId, 1);
      console.log(
        `[game-loop] spawned new character id=${this.character.id} at (${this.character.position.x},${this.character.position.y})`,
      );
    }
    // Phase 3 — seed baseline (river etc.) then load. Baseline is idempotent
    // so it's safe to call on every init; lineage inheritance is preserved.
    this.glossaryRepo.seedBaseline(this.character.id, Date.now());
    this.character.glossary = this.glossaryRepo.load(this.character.id);
    const t = this.gameTime();
    const hourKey = t.day * TIME_CONFIG.gameHoursPerDay + t.hour;
    this.lastHourKey = hourKey;
    this.lastDayKey = t.day;
    this.lastTreeDropHourKey = hourKey;
    this.lastChickenRespawnHourKey = hourKey;
    this.lastFishRespawnHourKey = hourKey;
    this.currentDayStartMs = Date.now();
    // Seed unique id counter above any existing numeric suffix.
    this.nextResourceId = Date.now();
    this.refreshRulesCache();
    this.refreshSpatialMemory();
    this.refreshChunkVisits();
    this.refreshDailyGoal();
    this.maybeGenerateLifeGoal();
    // Day-1 boot has no day boundary to trigger generation, so kick off
    // daily-goal here when the live character has none persisted yet.
    this.maybeGenerateDailyGoal(this.gameTime().day);
  }

  private refreshSpatialMemory(): void {
    this.knownResources.clear();
    if (!this.character) return;
    const rows = this.spatialRepo.loadFor(this.character.id);
    for (const r of rows) this.knownResources.set(r.resourceId, r);
    if (rows.length > 0) {
      console.log(
        `[game-loop] loaded ${rows.length} spatial memories for character ${this.character.id}`,
      );
    }
  }

  private refreshChunkVisits(): void {
    this.chunkVisits.clear();
    this.lastChunkKey = null;
    if (!this.character) return;
    const rows = this.chunkVisitRepo.loadFor(this.character.id);
    for (const v of rows) this.chunkVisits.set(chunkKey(v.cx, v.cy), v);
    if (rows.length > 0) {
      console.log(
        `[game-loop] loaded ${rows.length} chunk visits for character ${this.character.id}`,
      );
    }
  }

  // Per-tick: detect chunk-boundary crossing and upsert the new chunk. Cheap
  // (one Math.floor per tick on the cached lastChunkKey path); only writes
  // when the character actually enters a new chunk.
  private trackChunkVisit(): void {
    if (!this.character || !this.character.isAlive) return;
    const { cx, cy } = tileToChunk(this.character.position.x, this.character.position.y);
    const key = chunkKey(cx, cy);
    if (key === this.lastChunkKey) return;
    this.lastChunkKey = key;
    const now = Date.now();
    this.chunkVisitRepo.upsert(this.character.id, cx, cy, now);
    const existing = this.chunkVisits.get(key);
    const isNew = !existing;
    this.chunkVisits.set(key, {
      cx,
      cy,
      visitCount: (existing?.visitCount ?? 0) + 1,
      lastVisitT: now,
    });
    if (isNew) this.evaluateDailyGoalCheck({ kind: 'chunk_visited_new' });
  }

  /** Project remembered resource IDs onto current world state. Drops entries
   *  whose IDs no longer exist (consumed/hunted/picked-up). Returned list is
   *  what the AI is "allowed" to plan against — anything outside this set is
   *  unknown to the character even if it physically exists in the world. */
  private materializeKnownResources(): Resource[] {
    if (this.knownResources.size === 0) return [];
    const out: Resource[] = [];
    for (const id of this.knownResources.keys()) {
      const live = this.resources.find((r) => r.id === id);
      if (live) out.push(live);
    }
    return out;
  }

  // Fire-and-forget life-goal generation for the current character. Called on
  // boot (existing or fresh) and on respawn. Skips if the character already has
  // a persisted goal (from a previous boot), if Ollama is unavailable, or if a
  // call is already in flight. The character runs goal-less until the call
  // resolves; failures leave lifeGoal=null and the character behaves as before.
  private maybeGenerateLifeGoal(): void {
    if (!this.character || !this.character.isAlive) return;
    if (this.character.lifeGoal) return;
    if (!this.ollamaOptions) return;
    if (this.lifeGoalInFlight) return;
    const c = this.character;
    const opts = this.ollamaOptions;
    const known = Array.from(this.knownResources.values());
    const visits = Array.from(this.chunkVisits.values());
    const gameDay = this.gameTime().day;
    this.lifeGoalInFlight = true;
    void generateLifeGoal({
      character: c,
      knownResources: known,
      chunkVisits: visits,
      eventRepo: this.eventRepo,
      characterRepo: this.repo,
      lineageId: this.lineageId,
      cachedRules: this.cachedRules,
      ollama: opts,
      gameDay,
      onLog: (line) => console.log(line),
    })
      .then((goal) => {
        if (!goal) return;
        if (!this.character || this.character.id !== c.id || !this.character.isAlive) return;
        this.character.lifeGoal = goal;
        this.repo.persist(this.character);
        this.pushLog('pick', `life-goal: ${goal.text} (priority ${goal.priority})`);
        if (goal.diagnosis) this.pushLog('pick', `diagnosis: ${goal.diagnosis}`);
        this.logEvent('life_goal_set', {
          goal: goal.text,
          reason: goal.reason,
          priority: goal.priority,
          diagnosis: goal.diagnosis ?? null,
        });
      })
      .catch((err) => {
        console.warn('[life-goal] uncaught error:', err);
      })
      .finally(() => {
        this.lifeGoalInFlight = false;
      });
  }

  private refreshRulesCache(): void {
    const rules = this.ruleRepo.loadActive(this.lineageId);
    this.cachedRules = rules.map((r) => r.text);
    if (rules.length > 0) {
      console.log(`[game-loop] loaded ${rules.length} active rules for lineage ${this.lineageId}`);
    }
  }

  // Pull the current character's active daily goal off disk and stamp it onto
  // the character so prompts + WS broadcast see it. Idempotent — repo returns
  // null when no in-progress row exists, which clears the field.
  private refreshDailyGoal(): void {
    if (!this.character) return;
    const goal = this.dailyGoalRepo.loadActive(this.character.id);
    this.character.dailyGoal = goal ?? null;
    if (goal) {
      console.log(
        `[game-loop] loaded daily goal id=${goal.id} day=${goal.day} step=${goal.currentStepIdx}/${goal.subGoals.length} alignment=${goal.alignment} for character ${this.character.id}`,
      );
    }
  }

  // Fire-and-forget daily-goal generation for the current character on the
  // given game-day. Skips when ollama is off, no live character, the call is
  // already in flight, or an in-progress goal already exists for this day
  // (avoids re-rolling the plan mid-day on a server restart). On success the
  // goal is stamped onto character.dailyGoal so prompts + WS broadcast see it.
  private maybeGenerateDailyGoal(targetDay: number): void {
    if (!this.character || !this.character.isAlive) return;
    if (!this.ollamaOptions) return;
    if (this.dailyGoalInFlight) return;
    const existing = this.dailyGoalRepo.loadForDay(this.character.id, targetDay);
    if (existing && existing.status === 'in_progress') {
      this.character.dailyGoal = existing;
      return;
    }
    const c = this.character;
    const opts = this.ollamaOptions;
    const known = Array.from(this.knownResources.values());
    const visits = Array.from(this.chunkVisits.values());
    const yesterday = targetDay > 1
      ? this.dailyGoalRepo.loadForDay(c.id, targetDay - 1)
      : null;
    this.dailyGoalInFlight = true;
    void generateDailyGoal({
      character: c,
      lifeGoal: c.lifeGoal ?? null,
      knownResources: known,
      chunkVisits: visits,
      eventRepo: this.eventRepo,
      cachedRules: this.cachedRules,
      yesterdayGoal: yesterday,
      ollama: opts,
      gameDay: targetDay,
      repo: this.dailyGoalRepo,
      onLog: (line) => console.log(line),
    })
      .then((goal) => {
        if (!goal) return;
        if (!this.character || this.character.id !== c.id || !this.character.isAlive) return;
        this.character.dailyGoal = goal;
        this.pushLog(
          'pick',
          `daily-goal D${goal.day} (${goal.alignment}): ${goal.summary}`,
        );
        this.logEvent('daily_goal_set', {
          day: goal.day,
          alignment: goal.alignment,
          summary: goal.summary,
          steps: goal.subGoals.length,
        });
        if (this.pendingChunkVisitedNew) {
          this.pendingChunkVisitedNew = false;
          this.evaluateDailyGoalCheck({ kind: 'chunk_visited_new' });
        }
      })
      .catch((err) => {
        console.warn('[daily-goal] uncaught error:', err);
      })
      .finally(() => {
        this.dailyGoalInFlight = false;
      });
  }

  start(onTick: (state: GameState) => void): void {
    if (this.tickHandle) return;
    this.tickHandle = setInterval(() => {
      this.tickCount++;
      this.maybeRespawn();
      this.applyHourlyDecay();
      this.applyDailyRegen();
      this.applyPhysicsTick();
      this.applyTreeAutoDrop();
      this.applyAnimalRespawn();
      this.advanceAnimals();
      // Fire-and-forget — advanceAI mutates this.plan / character.currentAction
      // when it resolves. The current tick still broadcasts immediately so
      // walking/anim updates aren't blocked by a slow LLM call.
      void this.advanceAI();
      this.scanVisionAndUpdateMemory();
      this.trackChunkVisit();
      if (this.character && this.tickCount % CHARACTER_CONFIG.persistEveryTicks === 0) {
        this.repo.persist(this.character);
      }
      onTick(this.snapshot());
    }, TIME_CONFIG.tickMs);
  }

  private scanVisionAndUpdateMemory(): void {
    if (!this.character || !this.character.isAlive) return;
    if (this.tickCount - this.lastVisionTick < VISION_CONFIG.scanEveryTicks) return;
    this.lastVisionTick = this.tickCount;
    const t = this.gameTime();
    const range = visionRangeForHour(t.hour, { nearLitFire: this.isCharNearLitFire() });
    const result = scanVision(
      this.character.position,
      this.character.facing,
      this.resources,
      this.blocked,
      { range, fovDegrees: VISION_CONFIG.fovDegrees },
    );
    this.lastVisibleTiles = result.tilesInCone;
    for (const t of result.tilesInCone) this.cumulativeExploredTiles.add(t);
    const now = Date.now();
    const newlyDiscovered: Resource[] = [];
    for (const r of result.visibleResources) {
      const had = this.knownResources.has(r.id);
      this.knownResources.set(r.id, {
        resourceId: r.id,
        type: r.type,
        x: r.x,
        y: r.y,
        lastSeenT: now,
      });
      if (!had) newlyDiscovered.push(r);
    }
    if (newlyDiscovered.length > 0) {
      this.spatialRepo.upsertBatch(this.character.id, newlyDiscovered, now);
      const byType: Record<string, number> = {};
      for (const r of newlyDiscovered) byType[r.type] = (byType[r.type] ?? 0) + 1;
      const summary = Object.entries(byType)
        .map(([type, n]) => `${n} ${type}${n > 1 ? 's' : ''}`)
        .join(', ');
      this.pushLog('memorize', `saw ${summary}`);
    }
    // Forget remembered resources whose tile is currently visible but the
    // resource is no longer there (picked up, hunted, etc.). Char standing in
    // line of sight to the location and not seeing it = it's gone.
    const visibleIds = new Set(result.visibleResources.map((r) => r.id));
    const toForget: Array<{ id: string; mem: RememberedResource }> = [];
    for (const [id, mem] of this.knownResources) {
      const tileKey = `${Math.round(mem.x)},${Math.round(mem.y)}`;
      if (result.tilesInCone.has(tileKey) && !visibleIds.has(id)) toForget.push({ id, mem });
    }
    for (const { id, mem } of toForget) {
      this.knownResources.delete(id);
      this.spatialRepo.forget(this.character.id, id);
      this.pushLog('forget', `${mem.type}@(${Math.round(mem.x)},${Math.round(mem.y)}) gone`);
    }
  }

  /** Public admin trigger — instant kill for testing. */
  kill(reason: DeathReason = 'admin'): boolean {
    if (!this.character || !this.character.isAlive) return false;
    this.triggerDeath(reason);
    return true;
  }

  /** Mutate a stat value directly (admin/test). Returns false if no live character or unknown stat.
   * Temperature is unbounded (it's degrees C, not a 0-100 score) so it skips the cap. */
  setStat(
    stat: 'hunger' | 'thirst' | 'bladder' | 'energy' | 'sickness' | 'health' | 'temperature',
    value: number,
  ): boolean {
    if (!this.character || !this.character.isAlive) return false;
    let v: number;
    if (stat === 'temperature') {
      v = value;
    } else {
      const max = stat === 'health' ? HEALTH_CONFIG.max : 100;
      v = Math.max(0, Math.min(max, value));
    }
    this.character.stats[stat] = v;
    this.repo.persist(this.character);
    return true;
  }

  addItem(item: string): boolean {
    if (!this.character || !this.character.isAlive) return false;
    this.character.inventory.push(item);
    this.repo.persist(this.character);
    return true;
  }

  setLineageListener(cb: LineageListener | null): void {
    this.lineageListener = cb;
  }

  /** Admin: force the reflection pipeline to run on the current day's events
   *  right now, without waiting for the game-day boundary. */
  async triggerReflectionNow(): Promise<{ ok: boolean; reason?: string; rulesAdded?: number; summary?: string }> {
    if (!this.ollamaOptions) return { ok: false, reason: 'ollama not configured (UDU_AI_MODE != llm)' };
    if (!this.character) return { ok: false, reason: 'no live character' };
    if (this.reflectionInFlight) return { ok: false, reason: 'reflection already in flight' };
    const opts = this.ollamaOptions;
    const lineageId = this.lineageId;
    const iteration = this.character.iteration;
    const daySinceMs = this.currentDayStartMs;
    const gameDay = this.gameTime().day;
    this.currentDayStartMs = Date.now();
    this.reflectionInFlight = true;
    try {
      const result = await runReflection(
        { lineageId, iteration, gameDay, daySinceMs },
        opts,
        this.eventRepo,
        this.ruleRepo,
        (line) => console.log(line),
      );
      if (result.ok) {
        this.refreshRulesCache();
        return { ok: true, rulesAdded: result.rulesAdded, summary: result.summary };
      }
      return { ok: false, reason: result.reason };
    } finally {
      this.reflectionInFlight = false;
    }
  }

  /** Admin/inspection helper — exposes lineage id so /api/admin/rules can list. */
  lineageIdForAdmin(): number {
    return this.lineageId;
  }

  private applyHourlyDecay(): void {
    if (!this.character || !this.character.isAlive) return;
    const t = this.gameTime();
    const hourKey = t.day * TIME_CONFIG.gameHoursPerDay + t.hour;
    if (hourKey <= this.lastHourKey) return;
    const lastHour = this.lastHourKey;
    this.lastHourKey = hourKey;

    const s = this.character.stats;
    const action = this.character.currentAction.type;
    const sleeping = action === 'sleep';
    const resting = action === 'rest';
    // Resting throttles non-energy drain (hunger/thirst/bladder) and grants a
    // small energy gain — sit-down recovery, weaker than sleep but real.
    const restMul = resting ? REST_CONFIG.decayMultiplier : 1;

    // Walk hourKey forward one game-hour at a time so each elapsed hour gets the
    // circadian multiplier of THAT hour, not just the latest tick's phase. Most
    // ticks see hoursElapsed=1; this matters when we cross a phase boundary.
    for (let h = lastHour + 1; h <= hourKey; h++) {
      const hourOfDay = ((h % TIME_CONFIG.gameHoursPerDay) + TIME_CONFIG.gameHoursPerDay) % TIME_CONFIG.gameHoursPerDay;
      const phase = currentPhase(hourOfDay);

      const energyRate = sleeping
        ? DECAY_RATES.energyPerGameHourSleep * CIRCADIAN.sleepRecovery[phase]
        : resting
          ? DECAY_RATES.energyPerGameHourRest * CIRCADIAN.sleepRecovery[phase]
          : DECAY_RATES.energyPerGameHourActive * CIRCADIAN.energyDecay[phase];

      s.hunger = clamp(s.hunger - DECAY_RATES.hungerPerGameHour * CIRCADIAN.hungerDecay[phase] * restMul);
      s.thirst = clamp(s.thirst - DECAY_RATES.thirstPerGameHour * CIRCADIAN.thirstDecay[phase] * restMul);
      s.bladder = clamp(s.bladder + DECAY_RATES.bladderPerGameHour * CIRCADIAN.bladderDecay[phase] * restMul);
      s.energy = clamp(s.energy - energyRate);

      // Sickness funnel: bladder pinned at 100 actively makes char sick;
      // recovery only when bladder is comfortably low. Raw-meat lingering is
      // approximated by the +20 spike from eating raw meat + slow -2/h recovery
      // (≈10 game-hours to clear), so no extra "raw meat in system" tracker.
      const sickness = s.sickness ?? 0;
      if (s.bladder >= SICKNESS_FUNNEL.bladderFullThreshold) {
        s.sickness = clamp(sickness + SICKNESS_FUNNEL.bladderFullDrainPerGameHour);
      } else if (s.bladder < SICKNESS_FUNNEL.recoveryBladderCeil) {
        s.sickness = clamp(sickness - SICKNESS_FUNNEL.recoveryPerGameHour);
      } else {
        s.sickness = sickness; // bladder mid-range: hold steady
      }

      // Fire fuel — burn one wood per game-hour while lit. Out of fuel → unlit.
      // Run BEFORE temperature drift so the same hour's fire warmth uses the
      // post-burn lit state (fuel ran out this hour → no warmth bonus).
      this.burnFireForOneGameHour();

      // Temperature drift toward ambient. Fire radius (lit only) overrides
      // ambient to TEMPERATURE_CONFIG.fireWarmthAmbient. Drift rate caps at
      // 18°C/game-hour (0.3°C/game-min × 60) so body temp lags strategic-fast,
      // not instant.
      this.applyTemperatureDriftForOneGameHour(hourOfDay);

      // HP processing — drives at 0 drain at distinct rates, sickness ≥80
      // drains, body-temp drift (<20 or >30) drains directly with sleep+fire
      // modifiers, regen kicks in when thriving and awake. Multiple drains stack
      // so neglecting drives AND warmth at once kills faster.
      this.applyHpForOneGameHour(sleeping);
      if (s.health <= 0) break;
    }

    if (s.health <= 0 && this.character.isAlive) {
      this.triggerDeath(this.lastHpCause);
    }
  }

  /** Find the fire resource (single fire pit; first hit wins). */
  private findFire(): Resource | undefined {
    return this.resources.find((r) => r.type === 'fire');
  }

  /** True if char is within warmth radius of a LIT fire. */
  private isCharNearLitFire(): boolean {
    if (!this.character) return false;
    const fire = this.findFire();
    if (!fire) return false;
    if (fire.state.lit === false) return false;
    const dx = this.character.position.x - fire.x;
    const dy = this.character.position.y - fire.y;
    return Math.hypot(dx, dy) <= FIRE_CONFIG.warmthRadius;
  }

  /** Target ambient °C for the current hour. Fire radius + lit overrides phase. */
  private computeAmbient(hourOfDay: number): number {
    if (this.isCharNearLitFire()) return TEMPERATURE_CONFIG.fireWarmthAmbient;
    const phase = currentPhase(hourOfDay);
    return TEMPERATURE_CONFIG.phaseAmbient[phase];
  }

  /** Drift body temperature toward ambient one game-hour at a time. */
  private applyTemperatureDriftForOneGameHour(hourOfDay: number): void {
    if (!this.character) return;
    const s = this.character.stats;
    const target = this.computeAmbient(hourOfDay);
    const delta = target - s.temperature;
    if (delta === 0) return;
    const maxStep = TEMPERATURE_CONFIG.driftPerGameMinute * TIME_CONFIG.gameMinutesPerHour;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
    s.temperature = s.temperature + step;
  }

  /** Compute one game-hour of temperature-driven HP drain. Replaces the old
   * drives-drain path: cold/hot now drains health directly so the AI sees a
   * single clear cause→effect signal (temp drift → HP drop) instead of having
   * cold's punishment laundered through hunger/energy. */
  private computeTemperatureHpDrain(sleeping: boolean): number {
    if (!this.character) return 0;
    const t = this.character.stats.temperature;
    const tiers = HEALTH_CONFIG.drainPerGameHour;
    let raw = 0;
    if (t < 10) raw = tiers.tempColdSevere;
    else if (t < 20) raw = tiers.tempColdMild;
    else if (t > 40) raw = tiers.tempHotSevere;
    else if (t > 30) raw = tiers.tempHotMild;
    if (raw === 0) return 0;

    // Sleep + fire-radius + lit = full immunity (the load-bearing learn).
    // Sleep alone = 0.5×. Awake = 1×.
    if (sleeping) {
      if (TEMPERATURE_CONFIG.fireSleepImmunity && this.isCharNearLitFire()) return 0;
      return raw * TEMPERATURE_CONFIG.sleepDrainMultiplier;
    }
    return raw;
  }

  /** Burn one game-hour of fuel from each lit fire. Unlit when fuel hits 0. */
  private burnFireForOneGameHour(): void {
    for (const r of this.resources) {
      if (r.type !== 'fire') continue;
      const lit = r.state.lit !== false;
      if (!lit) continue;
      const fuel = typeof r.state.fuel === 'number' ? r.state.fuel : FIRE_CONFIG.initialFuel;
      const next = fuel - FIRE_CONFIG.burnPerGameHour;
      if (next <= 0) {
        r.state = { ...r.state, fuel: 0, lit: false };
        this.logEvent('fire_unlit', { id: r.id });
      } else {
        r.state = { ...r.state, fuel: next };
      }
      this.resourceRepo.persist(r);
    }
  }

  /** Apply one game-hour of HP drain or regen based on current stats. */
  private applyHpForOneGameHour(sleeping: boolean): void {
    if (!this.character) return;
    const s = this.character.stats;
    const drainHunger = s.hunger <= 0 ? HEALTH_CONFIG.drainPerGameHour.hunger0 : 0;
    const drainThirst = s.thirst <= 0 ? HEALTH_CONFIG.drainPerGameHour.thirst0 : 0;
    const drainEnergy = s.energy <= 0 ? HEALTH_CONFIG.drainPerGameHour.energy0 : 0;
    const drainSickness = (s.sickness ?? 0) >= HEALTH_CONFIG.sicknessDrainThreshold
      ? HEALTH_CONFIG.drainPerGameHour.sickness80
      : 0;
    const drainTemp = this.computeTemperatureHpDrain(sleeping);
    const totalDrain = drainHunger + drainThirst + drainEnergy + drainSickness + drainTemp;

    if (totalDrain > 0) {
      s.health = Math.max(0, s.health - totalDrain);
      const causes: { name: DeathReason; drain: number }[] = [
        { name: 'starvation', drain: drainHunger },
        { name: 'dehydration', drain: drainThirst },
        { name: 'exhaustion', drain: drainEnergy },
        { name: 'illness', drain: drainSickness },
        { name: 'exposure', drain: drainTemp },
      ];
      causes.sort((a, b) => b.drain - a.drain);
      this.lastHpCause = causes[0].name;
      return;
    }

    if (sleeping) return;
    const r = HEALTH_CONFIG.regen;
    if (
      s.hunger >= r.needsFloor &&
      s.thirst >= r.needsFloor &&
      s.energy >= r.needsFloor &&
      s.bladder <= r.bladderCeil &&
      (s.sickness ?? 0) < r.sicknessCeil
    ) {
      s.health = Math.min(HEALTH_CONFIG.max, s.health + r.perGameHour);
    }
  }

  private triggerDeath(reason: DeathReason): void {
    if (!this.character || !this.character.isAlive) return;
    const c = this.character;
    const deathTime = Date.now();
    const lifespanGameHours =
      (deathTime - c.spawnedAt) / (this.effectiveMsPerGameMinute() * TIME_CONFIG.gameMinutesPerHour);
    this.deathPosition = { x: c.position.x, y: c.position.y };
    c.isAlive = false;
    c.currentAction = { type: 'idle', startedAt: deathTime };
    this.plan = null;
    const chunksVisitedAtDeath = this.chunkVisits.size;
    const resourcesDiscoveredAtDeath = this.knownResources.size;
    this.repo.recordDeath(
      c.id,
      deathTime,
      reason,
      lifespanGameHours,
      chunksVisitedAtDeath,
      resourcesDiscoveredAtDeath,
    );
    const t = this.gameTime();
    this.logEvent('death', {
      reason,
      iteration: c.iteration,
      day: t.day,
      x: c.position.x,
      y: c.position.y,
      lifespanGameHours,
    });
    console.log(
      `[game-loop] character died id=${c.id} iter=${c.iteration} reason=${reason} lifespan=${lifespanGameHours.toFixed(2)}gh at (${c.position.x.toFixed(2)},${c.position.y.toFixed(2)})`,
    );
    this.lineageListener?.({
      event: 'death',
      deceasedCharacterId: c.id,
      reason,
      lifespanGameHours,
    });
    this.pushLog('death', `died: ${reason} (iter ${c.iteration}, ${lifespanGameHours.toFixed(1)}gh)`);
    // Wipe spatial memory — each new generation must rediscover the world.
    // Object knowledge stays alive via the rule table (reflection / spirit
    // memory). Both in-memory cache and DB row cleared.
    this.spatialRepo.clearFor(c.id);
    this.knownResources.clear();
    this.chunkVisitRepo.clearFor(c.id);
    this.chunkVisits.clear();
    this.lastChunkKey = null;
    this.lastVisibleTiles.clear();
    this.cumulativeExploredTiles.clear();
    this.respawnAt = Date.now() + DEATH_CONFIG.respawnDelayMs;
    this.lastHpCause = 'starvation';
  }

  private maybeRespawn(): void {
    if (this.respawnAt === null) return;
    if (Date.now() < this.respawnAt) return;

    const deathPos = this.deathPosition ?? { x: CHARACTER_CONFIG.spawnX, y: CHARACTER_CONFIG.spawnY };
    const pos = this.pickRespawnPosition(deathPos);
    const parentId = this.character?.id ?? null;
    const newIteration = this.repo.incrementIteration(this.lineageId);
    const fresh = this.repo.spawn(this.lineageId, newIteration, pos);
    this.character = fresh;
    // Phase 3 — lineage inheritance. Copy parent's full glossary to the new
    // gen so it doesn't relearn what the bloodline already discovered. Gen 1
    // (no parent) writes nothing and starts blank.
    if (parentId !== null) {
      const inherited = this.glossaryRepo.inherit(parentId, fresh.id, Date.now());
      if (inherited > 0) {
        console.log(`[game-loop] glossary: inherited ${inherited} entries from char ${parentId} → ${fresh.id}`);
      }
    }
    this.glossaryRepo.seedBaseline(fresh.id, Date.now());
    this.character.glossary = this.glossaryRepo.load(fresh.id);

    this.respawnAt = null;
    this.deathPosition = null;
    this.lastHpCause = 'starvation';
    this.observations = [];
    this.pendingChunkVisitedNew = false;
    this.suppressSleepUntilTick = -1;
    this.consecutiveCortexFailures = 0;
    // New generation inherits the latest rules — pick up anything reflection
    // emitted during the previous life or in the gap between death and respawn.
    this.refreshRulesCache();
    // Re-anchor decay clock so fresh stats don't get retroactive damage.
    const t = this.gameTime();
    this.lastHourKey = t.day * TIME_CONFIG.gameHoursPerDay + t.hour;

    // Fresh generation, fresh log. Single 'respawn' entry stays as the floor
    // marker so the dev panel shows when the new life began.
    this.aiLog = [];
    this.pushLog('respawn', `respawn iter ${newIteration} at (${pos.x},${pos.y})`);
    this.logEvent('spawn', { iteration: newIteration, x: pos.x, y: pos.y });
    this.maybeGenerateLifeGoal();
    // Fresh character_id starts goal-less — repo is char-scoped, so loadActive
    // returns null. Kick off generation for the day the new life starts in.
    this.refreshDailyGoal();
    this.maybeGenerateDailyGoal(this.gameTime().day);
    console.log(
      `[game-loop] character respawned id=${fresh.id} iter=${newIteration} at (${pos.x},${pos.y})`,
    );
    this.lineageListener?.({
      event: 'respawn',
      newIteration,
      characterId: fresh.id,
    });
  }

  private pickRespawnPosition(deathPos: Position): Position {
    const { widthTiles, heightTiles } = MAP_CONFIG;
    const minDist = DEATH_CONFIG.minRespawnDistanceTiles;
    const occupied = this.occupiedTiles();
    const tryPick = (enforceDist: boolean): Position | null => {
      for (let attempt = 0; attempt < 500; attempt++) {
        const x = Math.floor(Math.random() * widthTiles);
        const y = Math.floor(Math.random() * heightTiles);
        const key = `${x},${y}`;
        if (this.blocked.has(key) || occupied.has(key)) continue;
        if (enforceDist) {
          const dx = x - deathPos.x;
          const dy = y - deathPos.y;
          if (Math.hypot(dx, dy) < minDist) continue;
        }
        return { x, y };
      }
      return null;
    };
    return tryPick(true) ?? tryPick(false) ?? { x: CHARACTER_CONFIG.spawnX, y: CHARACTER_CONFIG.spawnY };
  }

  private applyDailyRegen(): void {
    const currentDay = this.gameTime().day;
    if (currentDay <= this.lastDayKey) return;
    let bushGain = 0;
    let fruitGain = 0;
    let vineGain = 0;
    let branchGain = 0;
    for (let day = this.lastDayKey + 1; day <= currentDay; day++) {
      const fruitRegenToday = day % REGEN_CONFIG.treeFruitEveryDays === 0;
      const vineRegenToday = day % REGEN_CONFIG.treeVineEveryDays === 0;
      // tree_wood refills 1 branch every game-day (treeWoodRefillGameHours=24).
      for (const r of this.resources) {
        if (r.state?.barren) continue;
        if (r.type === 'bush') {
          const cur = Number(r.state?.berries ?? 0);
          if (cur < REGEN_CONFIG.bushBerriesMax) {
            const next = Math.min(cur + REGEN_CONFIG.bushBerryPerDay, REGEN_CONFIG.bushBerriesMax);
            r.state = { ...r.state, berries: next };
            this.resourceRepo.persist(r);
            bushGain += next - cur;
          }
        } else if (r.type === 'tree_fruit' && fruitRegenToday) {
          const cur = Number(r.state?.fruits ?? 0);
          if (cur < REGEN_CONFIG.treeFruitsMax) {
            const next = Math.min(cur + REGEN_CONFIG.treeFruitPerCycle, REGEN_CONFIG.treeFruitsMax);
            r.state = { ...r.state, fruits: next };
            this.resourceRepo.persist(r);
            fruitGain += next - cur;
          }
        } else if (r.type === 'tree_vine' && vineRegenToday) {
          const cur = Number(r.state?.vines ?? 0);
          if (cur < REGEN_CONFIG.treeVinesMax) {
            const next = Math.min(cur + 1, REGEN_CONFIG.treeVinesMax);
            r.state = { ...r.state, vines: next };
            this.resourceRepo.persist(r);
            vineGain += next - cur;
          }
        } else if (r.type === 'tree_wood') {
          const cur = Number(r.state?.branches ?? 0);
          if (cur < REGEN_CONFIG.treeWoodBranchesMax) {
            const next = Math.min(cur + 1, REGEN_CONFIG.treeWoodBranchesMax);
            r.state = { ...r.state, branches: next };
            this.resourceRepo.persist(r);
            branchGain += next - cur;
          }
        }
      }
    }
    const previousDay = this.lastDayKey;
    this.lastDayKey = currentDay;
    if (bushGain > 0 || fruitGain > 0 || vineGain > 0 || branchGain > 0) {
      this.logEvent('resource_regen', { day: currentDay, bushGain, fruitGain, vineGain, branchGain });
    }
    // Day boundary: kick off reflection asynchronously for the day that just
    // ended. Background — won't block the tick. New rules land in cachedRules
    // when the LLM call resolves, picked up by subsequent feed decisions.
    if (currentDay > previousDay && previousDay >= 1) {
      this.scheduleReflection(previousDay);
    }
    // Same boundary — generate the new day's plan. Reflection and daily-goal
    // run in parallel; daily-goal sees stale rules on the first tick after
    // rollover, then the next decide tick uses fresh rules once reflection
    // lands. Acceptable v1: missing one day's freshly-learned rule is cheaper
    // than serializing the LLM calls.
    if (currentDay > previousDay) {
      this.maybeGenerateDailyGoal(currentDay);
    }
  }

  private scheduleReflection(endedDay: number): void {
    if (this.reflectionInFlight) return;
    if (!this.ollamaOptions) return;
    if (!this.character) return;
    const opts = this.ollamaOptions;
    const lineageId = this.lineageId;
    const iteration = this.character.iteration;
    const daySinceMs = this.currentDayStartMs;
    this.currentDayStartMs = Date.now();
    this.reflectionInFlight = true;
    void runReflection(
      { lineageId, iteration, gameDay: endedDay, daySinceMs },
      opts,
      this.eventRepo,
      this.ruleRepo,
      (line) => console.log(line),
    )
      .then((result) => {
        if (result.ok) this.refreshRulesCache();
      })
      .catch((err) => {
        console.warn('[reflection] uncaught error:', err);
      })
      .finally(() => {
        this.reflectionInFlight = false;
      });
  }

  // Phase 2 — server-side physics. Items in flight (z>0 OR |v|>threshold)
  // integrate gravity + air friction each tick. Settled items skip entirely so
  // a map full of dropped fruit doesn't burn cycles. Persisted on settle so
  // restart resumes positions without resimulating from spawn pos.
  private applyPhysicsTick(): void {
    const g = PHYSICS_CONFIG.gravity;
    const fr = PHYSICS_CONFIG.airFriction;
    const eps = PHYSICS_CONFIG.settleThreshold;
    for (const r of this.resources) {
      const z = r.z ?? 0;
      const vx = r.vx ?? 0;
      const vy = r.vy ?? 0;
      const vz = r.vz ?? 0;
      // Resting on the ground with negligible velocity → not in flight.
      if (z <= 0 && Math.abs(vx) < eps && Math.abs(vy) < eps && Math.abs(vz) < eps) continue;
      // Semi-implicit Euler — apply gravity to vz first, then integrate.
      let nvz = vz - g;
      let nz = z + nvz;
      let nvx = vx * fr;
      let nvy = vy * fr;
      let nx = r.x + nvx;
      let ny = r.y + nvy;
      // Ground impact — clamp z to 0 and zero vertical velocity. Horizontal
      // velocity persists into a quick slide, friction soaks it up next ticks.
      if (nz <= 0) {
        nz = 0;
        nvz = 0;
        // Once landed, wipe small horizontal jitter so the item isn't a
        // continually-twitching float.
        if (Math.abs(nvx) < eps) nvx = 0;
        if (Math.abs(nvy) < eps) nvy = 0;
      }
      // Map bounds clamp — items can't fly off the world.
      nx = Math.max(0, Math.min(MAP_CONFIG.widthTiles - 0.001, nx));
      ny = Math.max(0, Math.min(MAP_CONFIG.heightTiles - 0.001, ny));
      r.x = nx;
      r.y = ny;
      r.z = nz === 0 ? undefined : nz;
      r.vx = nvx === 0 ? undefined : nvx;
      r.vy = nvy === 0 ? undefined : nvy;
      r.vz = nvz === 0 ? undefined : nvz;
      // Persist only on settle — mid-flight positions don't need to survive a
      // crash mid-arc, the next spawn resims from canonical state. On full
      // settle (z=0, all v=0) save once so restart picks up the landing pos.
      const settled = nz === 0 && nvx === 0 && nvy === 0 && nvz === 0;
      if (settled) this.resourceRepo.persist(r);
    }
  }

  // Phase A.1 — every `treeAutoDropGameHours`, each productive tree releases
  // one item from its stash. Spawns at the tree's tile with physics so it
  // arcs out via gravity (Phase 2 — replaces adjacent-tile placement).
  private applyTreeAutoDrop(): void {
    const t = this.gameTime();
    const hourKey = t.day * TIME_CONFIG.gameHoursPerDay + t.hour;
    if (hourKey - this.lastTreeDropHourKey < REGEN_CONFIG.treeAutoDropGameHours) return;
    this.lastTreeDropHourKey = hourKey;

    const occupied = this.occupiedTiles();
    let droppedFruit = 0;
    let droppedBranch = 0;
    let droppedVine = 0;

    for (const tree of this.resources) {
      let stashKey: 'fruits' | 'branches' | 'vines';
      let groundType: 'fruit' | 'branch' | 'vine';
      let idPrefix: string;
      if (tree.type === 'tree_fruit') {
        stashKey = 'fruits';
        groundType = 'fruit';
        idPrefix = 'fruit';
      } else if (tree.type === 'tree_wood') {
        stashKey = 'branches';
        groundType = 'branch';
        idPrefix = 'branch';
      } else if (tree.type === 'tree_vine') {
        stashKey = 'vines';
        groundType = 'vine';
        idPrefix = 'vine';
      } else {
        continue;
      }

      const stash = Number(tree.state?.[stashKey] ?? 0);
      if (stash <= 0) continue;

      const id = `${idPrefix}_${++this.nextResourceId}`;
      const init = DROP_INIT.treeAutoDrop();
      const drop: Resource = {
        id,
        type: groundType,
        x: tree.x,
        y: tree.y,
        state: { source: tree.id },
        z: init.z,
        vx: init.vx,
        vy: init.vy,
        vz: init.vz,
      };
      this.resources.push(drop);
      this.resourceRepo.persist(drop);

      tree.state = { ...tree.state, [stashKey]: stash - 1 };
      this.resourceRepo.persist(tree);

      if (tree.type === 'tree_fruit') droppedFruit++;
      else if (tree.type === 'tree_wood') droppedBranch++;
      else droppedVine++;
    }

    if (droppedFruit + droppedBranch + droppedVine > 0) {
      this.logEvent('tree_auto_drop', { fruit: droppedFruit, branch: droppedBranch, vine: droppedVine });
    }
  }

  private applyAnimalRespawn(): void {
    const t = this.gameTime();
    const hourKey = t.day * TIME_CONFIG.gameHoursPerDay + t.hour;

    // Chicken respawn on land.
    if (hourKey - this.lastChickenRespawnHourKey >= ANIMAL_CONFIG.chickenRespawnGameHours) {
      const chickens = this.resources.filter((r) => r.type === 'animal_chicken');
      if (chickens.length < ANIMAL_CONFIG.chickenCount) {
        const spawned = this.spawnChicken();
        if (spawned) {
          this.logEvent('chicken_spawn', { id: spawned.id, x: spawned.x, y: spawned.y });
          this.lastChickenRespawnHourKey = hourKey;
        }
      } else {
        this.lastChickenRespawnHourKey = hourKey;
      }
    }

    // Fish respawn on river tiles.
    if (hourKey - this.lastFishRespawnHourKey >= ANIMAL_CONFIG.fishRespawnGameHours) {
      const fish = this.resources.filter((r) => r.type === 'animal_fish');
      if (fish.length < ANIMAL_CONFIG.fishCount) {
        const spawned = this.spawnFish();
        if (spawned) {
          this.logEvent('fish_spawn', { id: spawned.id, x: spawned.x, y: spawned.y });
          this.lastFishRespawnHourKey = hourKey;
        }
      } else {
        this.lastFishRespawnHourKey = hourKey;
      }
    }
  }

  private spawnChicken(): Resource | null {
    const occupied = this.occupiedTiles();
    const { widthTiles, heightTiles } = MAP_CONFIG;
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = Math.floor(Math.random() * widthTiles);
      const y = Math.floor(Math.random() * heightTiles);
      const key = `${x},${y}`;
      if (occupied.has(key) || this.blocked.has(key)) continue;
      const id = `chicken_${++this.nextResourceId}`;
      const res: Resource = {
        id,
        type: 'animal_chicken',
        x,
        y,
        state: { hunger: ANIMAL_CONFIG.chickenHungerStart },
      };
      this.resources.push(res);
      this.resourceRepo.persist(res);
      return res;
    }
    return null;
  }

  private spawnFish(): Resource | null {
    const river = this.resources.filter((r) => r.type === 'river');
    const occupiedFish = new Set(
      this.resources.filter((r) => r.type === 'animal_fish').map((r) => `${r.x},${r.y}`),
    );
    for (let attempt = 0; attempt < 50; attempt++) {
      const pick = river[Math.floor(Math.random() * river.length)];
      if (!pick) return null;
      if (occupiedFish.has(`${pick.x},${pick.y}`)) continue;
      const id = `fish_${pick.x}_${pick.y}_${++this.nextResourceId}`;
      const res: Resource = { id, type: 'animal_fish', x: pick.x, y: pick.y, state: {} };
      this.resources.push(res);
      this.resourceRepo.persist(res);
      return res;
    }
    return null;
  }

  private advanceAnimals(): void {
    const char = this.character;
    if (!char) return;
    const dtSec = TIME_CONFIG.tickMs / 1000;
    const persistThisTick = this.tickCount % 10 === 0;
    // Cache each tick — cheap, and fruit set mutates as chickens eat.
    const consumedFruits = new Set<string>();

    // Per-tick hunger decay: convert 'per game hour' into 'per real tick'.
    const dtGameHours =
      (TIME_CONFIG.tickMs / TIME_CONFIG.realMsPerGameMinute) /
      TIME_CONFIG.gameMinutesPerHour;
    const hungerDecayPerTick = ANIMAL_CONFIG.chickenHungerDecayPerGameHour * dtGameHours;

    const starvedIds: string[] = [];
    for (const r of this.resources) {
      if (r.type !== 'animal_chicken') continue;

      const distToChar = Math.hypot(r.x - char.position.x, r.y - char.position.y);
      const shouldFlee = distToChar < ANIMAL_CONFIG.chickenFleeRange;
      const state = (r.state ?? {}) as {
        target?: Position;
        fleeing?: boolean;
        fruitCooldownUntil?: number;
        hunger?: number;
      };
      const wasFleeing = state.fleeing ?? false;
      // Decay hunger and starve when it bottoms out. Existing chickens that
      // pre-date the field default to chickenHungerStart on first read.
      let hunger = state.hunger ?? ANIMAL_CONFIG.chickenHungerStart;
      hunger = Math.max(0, hunger - hungerDecayPerTick);
      r.state = { ...state, hunger };
      if (hunger <= 0) {
        starvedIds.push(r.id);
        continue;
      }
      // Suspend fruit-chasing for a window after the last failed step so the
      // chicken can wander out of a forest pocket instead of re-locking on
      // the same unreachable fruit every tick. Also gate by hunger — sated
      // chickens ignore fruit so they don't vacuum the map.
      const cooldownExpired = this.tickCount >= (state.fruitCooldownUntil ?? 0);
      const isHungry = hunger <= ANIMAL_CONFIG.chickenHungerChaseThreshold;
      const canChaseFruit = cooldownExpired && isHungry;

      // While not fleeing, head for the nearest fruit on the ground within range.
      // Lets chickens naturally declutter dropped fruit that the character ignored.
      let fruitTarget: Resource | null = null;
      if (!shouldFlee && canChaseFruit) {
        fruitTarget = this.findNearestFruitForChicken(r, consumedFruits);
      }

      if (fruitTarget) {
        // Eat on contact — otherwise steer toward the fruit tile.
        if (Math.hypot(fruitTarget.x - r.x, fruitTarget.y - r.y) < 0.5) {
          consumedFruits.add(fruitTarget.id);
          this.removeResource(fruitTarget.id);
          const filled = Math.min(
            ANIMAL_CONFIG.chickenHungerMax,
            hunger + ANIMAL_CONFIG.chickenHungerPerFruit,
          );
          this.logEvent('chicken_ate_fruit', { chicken: r.id, fruit: fruitTarget.id, hunger: filled });
          r.state = { ...r.state, target: undefined, fleeing: false, hunger: filled };
          continue;
        }
        r.state = {
          ...r.state,
          target: { x: fruitTarget.x, y: fruitTarget.y },
          fleeing: false,
        };
      }

      let target = (r.state as { target?: Position }).target;
      const reached = target
        ? Math.hypot(target.x - r.x, target.y - r.y) < 0.15
        : true;

      // Pick a new target when: no target, arrived, or transitioning into/out of flee.
      // (If fruitTarget was set above, `target` already points at the fruit tile.)
      if (!target || reached || shouldFlee !== wasFleeing) {
        target = shouldFlee
          ? this.pickChickenFleeTarget(r, char.position)
          : this.pickChickenWanderTarget(r);
        r.state = { ...r.state, target: target ?? undefined, fleeing: shouldFlee };
      }

      if (!target) continue;

      const dx = target.x - r.x;
      const dy = target.y - r.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.01) continue;

      const speed = shouldFlee
        ? ANIMAL_CONFIG.chickenFleeSpeedTilesPerSec
        : ANIMAL_CONFIG.chickenSpeedTilesPerSec;
      const step = speed * dtSec;
      let nx = dist <= step ? target.x : r.x + (dx / dist) * step;
      let ny = dist <= step ? target.y : r.y + (dy / dist) * step;

      // Tile-based blocked check with two escape valves so chickens don't
      // freeze when surrounded by trees:
      //   (A) sub-tile movement within the same logical tile is always allowed
      //       — lets a chicken trapped inside a blocked tile crawl out.
      //   (B) when the full step lands on a blocked tile, try sliding along
      //       walls by zeroing one axis at a time.
      const proposedTile = `${Math.round(nx)},${Math.round(ny)}`;
      const currentTile = `${Math.round(r.x)},${Math.round(r.y)}`;
      // Cooldown trigger: when a step toward a fruit fails, suspend fruit-chase
      // so the chicken doesn't re-lock onto the same unreachable target.
      const FRUIT_COOLDOWN_TICKS = 30;
      const failHandler = () => {
        const next = { ...r.state, target: undefined, fleeing: shouldFlee } as typeof state;
        if (fruitTarget) next.fruitCooldownUntil = this.tickCount + FRUIT_COOLDOWN_TICKS;
        r.state = next;
      };
      if (proposedTile !== currentTile && this.blocked.has(proposedTile)) {
        const xOnlyTile = `${Math.round(nx)},${Math.round(r.y)}`;
        const yOnlyTile = `${Math.round(r.x)},${Math.round(ny)}`;
        if (!this.blocked.has(xOnlyTile)) {
          ny = r.y;
        } else if (!this.blocked.has(yOnlyTile)) {
          nx = r.x;
        } else {
          failHandler();
          continue;
        }
      }

      // If slide produced zero movement (cardinal target hitting a wall), drop
      // the target so we repick next tick instead of looping silently.
      if (Math.abs(nx - r.x) < 1e-6 && Math.abs(ny - r.y) < 1e-6) {
        failHandler();
        continue;
      }

      r.x = nx;
      r.y = ny;
      if (persistThisTick) this.resourceRepo.persist(r);
    }

    // Remove starved chickens after iteration so we don't mutate the list
    // we're traversing. Respawn loop fills slots back up after
    // chickenRespawnGameHours.
    for (const id of starvedIds) {
      this.logEvent('chicken_starve', { chicken: id });
      this.removeResource(id);
    }
  }

  private findNearestFruitForChicken(
    chicken: Resource,
    skip: Set<string>,
  ): Resource | null {
    const RANGE = 5;
    let best: Resource | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const r of this.resources) {
      if (r.type !== 'fruit') continue;
      if (skip.has(r.id)) continue;
      // Fruits that landed on a blocked tile (under the parent tree) are
      // unreachable — chasing them would lock the chicken in a target loop.
      if (this.blocked.has(`${Math.round(r.x)},${Math.round(r.y)}`)) continue;
      const d = Math.hypot(r.x - chicken.x, r.y - chicken.y);
      if (d > RANGE) continue;
      if (d < bestDist) {
        bestDist = d;
        best = r;
      }
    }
    return best;
  }

  private pickChickenWanderTarget(chicken: Resource): Position | undefined {
    const { widthTiles, heightTiles } = MAP_CONFIG;
    const range = ANIMAL_CONFIG.chickenWanderRange;
    for (let attempt = 0; attempt < 20; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const dist = 2 + Math.random() * range;
      const x = chicken.x + Math.cos(angle) * dist;
      const y = chicken.y + Math.sin(angle) * dist;
      if (x < 0.5 || y < 0.5 || x > widthTiles - 1.5 || y > heightTiles - 1.5) continue;
      if (this.blocked.has(`${Math.round(x)},${Math.round(y)}`)) continue;
      return { x, y };
    }
    return undefined;
  }

  private pickChickenFleeTarget(chicken: Resource, charPos: Position): Position | undefined {
    const { widthTiles, heightTiles } = MAP_CONFIG;
    const dx = chicken.x - charPos.x;
    const dy = chicken.y - charPos.y;
    const mag = Math.hypot(dx, dy) || 1;
    const ux = dx / mag;
    const uy = dy / mag;
    for (let jit = 0; jit < 8; jit++) {
      const a = (Math.random() - 0.5) * 1.2;
      const rx = Math.cos(a) * ux - Math.sin(a) * uy;
      const ry = Math.sin(a) * ux + Math.cos(a) * uy;
      const tx = chicken.x + rx * ANIMAL_CONFIG.chickenFleeDistance;
      const ty = chicken.y + ry * ANIMAL_CONFIG.chickenFleeDistance;
      const cx = Math.max(0.5, Math.min(widthTiles - 1.5, tx));
      const cy = Math.max(0.5, Math.min(heightTiles - 1.5, ty));
      if (!this.blocked.has(`${Math.round(cx)},${Math.round(cy)}`)) return { x: cx, y: cy };
    }
    return undefined;
  }

  private async advanceAI(): Promise<void> {
    if (!this.character || !this.character.isAlive) return;

    // Run any final action deferred from last tick. Sleep & rest install
    // their own continuous state inside executeFinal — leave them alone.
    // Everything else is a one-shot, so reset to idle so the next broadcast
    // shows the character has moved on. Cook is now instant (no continuous tick).
    if (this.pendingFinal) {
      const finalAction = this.pendingFinal;
      this.pendingFinal = null;
      const before = this.snapshotForObservation();
      const failReason = this.executeFinal(finalAction);
      this.recordObservation(finalAction, before, failReason);
      if (finalAction.type !== 'sleep' && finalAction.type !== 'rest') {
        this.character.currentAction = { type: 'idle', startedAt: Date.now() };
      }
    }

    // Rest is a duration-based passive — character sits, decay throttles via
    // applyHourlyDecay's restMul. Survival overrides comfort: any need crossing
    // its trigger threshold (hunger/thirst/energy/bladder) breaks rest
    // immediately so the character stands up and acts. Otherwise the timed
    // window has to elapse before the character moves on.
    if (this.character.currentAction.type === 'rest') {
      const s = this.character.stats;
      const restPhase = currentPhase(this.gameTime().hour);
      const needFiring =
        s.hunger <= THRESHOLDS.hungerTrigger ||
        s.thirst <= THRESHOLDS.thirstTrigger ||
        s.energy <= CIRCADIAN.energySleepTrigger[restPhase] ||
        s.bladder >= THRESHOLDS.bladderTrigger;
      if (!needFiring && this.restEndsAtMs !== null && Date.now() < this.restEndsAtMs) return;
      this.restEndsAtMs = null;
      this.character.currentAction = { type: 'idle', startedAt: Date.now() };
    }

    // Active plan — advance it continuously toward next waypoint.
    if (this.plan) {
      if (this.plan.path.length > 0) {
        const dtSec = TIME_CONFIG.tickMs / 1000;
        const speed = this.currentSpeedTilesPerSec();
        let stepBudget = speed * dtSec;
        const initialBudget = stepBudget;
        const pos = this.character.position;
        // Update facing toward the next waypoint at start of step. Drives the
        // vision cone — char looks where it's heading.
        const head = this.plan.path[0];
        const fdx = head.x - pos.x;
        const fdy = head.y - pos.y;
        if (Math.hypot(fdx, fdy) > 0.01) {
          this.character.facing = Math.atan2(fdy, fdx);
        }
        // Consume step budget across waypoints if we arrive mid-tick (smooth corners).
        while (stepBudget > 0 && this.plan.path.length > 0) {
          const next = this.plan.path[0];
          const dx = next.x - pos.x;
          const dy = next.y - pos.y;
          const dist = Math.hypot(dx, dy);
          if (dist <= stepBudget + AI_CONFIG.arriveEpsilon) {
            pos.x = next.x;
            pos.y = next.y;
            stepBudget -= dist;
            this.plan.path.shift();
          } else {
            pos.x += (dx / dist) * stepBudget;
            pos.y += (dy / dist) * stepBudget;
            stepBudget = 0;
          }
        }
        // Tiles actually traversed this tick → per-tile decay. Captured as
        // (initial budget − leftover) so we charge for distance moved, not the
        // dtSec×speed cap (which over-charges if path runs out mid-tick).
        const tilesMoved = Math.max(0, initialBudget - stepBudget);
        if (tilesMoved > 0) this.applyTileDecay(tilesMoved);
        if (this.plan.path.length > 0) return;
      }
      // Path emptied (or plan started with empty path). Set the action label
      // and queue executeFinal for next tick so this tick's broadcast carries
      // the final action — gives the client one window to start the matching
      // anim (man_shake, man_bow, etc.). Side effects land next tick so the
      // visual order matches: do action → THEN state changes.
      this.character.currentAction = this.plan.finalAction;
      this.pendingFinal = this.plan.finalAction;
      this.plan = null;
      return;
    }

    // Sleep continues across ticks without a plan until energy recovers — but
    // any other critical need (or HP draining) wakes the char early. Without
    // this, a char that fell asleep with thirst already low can dehydrate to
    // death without ever standing up. Survival > deep recovery.
    if (this.character.currentAction.type === 'sleep') {
      const s = this.character.stats;
      const wakeForNeed =
        s.hunger <= THRESHOLDS.hungerTrigger ||
        s.thirst <= THRESHOLDS.thirstTrigger ||
        s.bladder >= THRESHOLDS.bladderTrigger;
      if (!wakeForNeed && s.energy < AI_CONFIG.sleepWakeEnergy) return;
      this.character.currentAction = { type: 'idle', startedAt: Date.now() };
      this.logEvent('sleep_end', { energy: s.energy, wakeForNeed });
      // Woken early by a triggered need — suppress sleep for a few decide cycles
      // so the need gets a chance to be handled before the character re-sleeps.
      if (wakeForNeed) this.suppressSleepUntilTick = this.tickCount + 6;
    }

    // No plan — decide periodically. Skip if the previous decide is still in
    // flight (LLM call) so we don't fire concurrent calls.
    if (this.decideInFlight) return;
    if (this.tickCount % AI_CONFIG.decideEveryTicks !== 0) return;

    this.decideInFlight = true;
    let result;
    try {
      // Build the per-resource lastSeenT map fresh from the live memory cache
      // (knownResources stores RememberedResource which already has the
      // timestamp). Cheap — handful of entries. Chunk visits are similarly
      // pulled by reference so any new entries since last decide are visible.
      const lastSeenById = new Map<string, number>();
      for (const [id, mem] of this.knownResources) lastSeenById.set(id, mem.lastSeenT);
      const t = this.gameTime();
      const phase = currentPhase(t.hour);
      const nearLitFire = this.isCharNearLitFire();
      const gameTimeStamp = `D${t.day} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
      const hints = {
        lastSeenById,
        chunkVisits: this.chunkVisits,
        nowMs: Date.now(),
        phase,
        nearLitFire,
        gameTimeStamp,
      };
      const fallbackOptions = {
        suppressSleep: this.tickCount < this.suppressSleepUntilTick,
        phase,
        nearLitFire,
      };
      if (this.cortexEnabled) {
        result = await cortexDecide(
          this.character,
          this.materializeKnownResources(),
          this.blocked,
          this.picker,
          this.observations,
          this.cachedRules,
          hints,
          fallbackOptions,
        );
        if (result) {
          this.consecutiveCortexFailures = 0;
        } else {
          this.consecutiveCortexFailures++;
          if (this.consecutiveCortexFailures >= 2) {
            const escape = this.buildEscapeWanderResult(hints);
            this.consecutiveCortexFailures = 0;
            if (escape) {
              this.logEvent('cortex_escape_valve', {
                pathLen: escape.plan.path.length,
                target: escape.plan.path[escape.plan.path.length - 1] ?? null,
              });
              this.pushLog('pick', 'ESCAPE: cortex stuck 2x, forced random wander');
              result = escape;
            }
          }
        }
      } else {
        result = await decide(
          this.character,
          this.materializeKnownResources(),
          this.blocked,
          this.picker,
          this.observations,
          this.cachedRules,
          hints,
          fallbackOptions,
        );
      }
    } finally {
      this.decideInFlight = false;
    }

    // Re-validate state after await — character may have died, started a new
    // continuous action (rest/sleep), or had a plan installed by another path.
    if (!this.character || !this.character.isAlive) return;
    if (this.plan) return;
    const cur = this.character.currentAction.type;
    if (cur !== 'idle' && cur !== 'walk_to' && cur !== 'wander') return;
    if (!result) return;

    const plan = result.plan;
    this.plan = plan;
    if (result.choice) {
      this.character.lastChoice = result.choice;
      this.character.lastReasoning = result.reasoning;
      this.character.lastChoiceAt = Date.now();
    }
    if (plan.path.length > 0) {
      this.character.currentAction = {
        type: 'walk_to',
        target: plan.finalAction.target ?? `${plan.path[plan.path.length - 1].x},${plan.path[plan.path.length - 1].y}`,
        startedAt: Date.now(),
      };
    } else {
      this.character.currentAction = plan.finalAction;
    }
    this.logEvent('action_start', {
      final: plan.finalAction.type,
      target: plan.finalAction.target ?? null,
      pathLen: plan.path.length,
      source: result.source ?? 'rule',
      choice: result.choice ?? null,
    });
    const finalType = plan.finalAction.type;
    if (result.source === 'llm' && result.reasoning) {
      this.pushLog('pick', `LLM:${result.choice ?? finalType} → ${result.reasoning}`);
    } else if (finalType === 'wander') {
      this.pushLog('wander', `rule:wander`);
    } else {
      const target = plan.finalAction.target ? ` (${plan.finalAction.target})` : '';
      this.pushLog('pick', `rule:${finalType}${target}`);
    }
    // Advance the active daily-goal sub-step when the LLM self-tagged that
    // this choice completes the current step. v1: trust the tag at decide
    // time — the action might still fail (blocked path, etc.) but the cost of
    // a false advance is minor (next reflection sees an unfinished plan).
    this.maybeAdvanceDailyGoal(result.advancesSubgoalIdx ?? null, result.completesSubgoal ?? null);
  }

  // Hybrid AC: structured server-side advance for sub-goals whose `check` field
  // matches the trigger that just fired. Action/inventory/chunk-visit signals
  // route through here; vague sub-goals without `check` keep falling back to
  // maybeAdvanceDailyGoal below (LLM self-tag at choice time). Both paths share
  // dailyGoalRepo.advanceStep, which is idempotent — duplicate triggers on the
  // same step are no-ops.
  private evaluateDailyGoalCheck(
    trigger:
      | { kind: 'action_performed'; value: string }
      | { kind: 'inventory_changed' }
      | { kind: 'chunk_visited_new' },
  ): void {
    if (!this.character) return;
    const goal = this.character.dailyGoal;
    if (!goal || goal.status !== 'in_progress') {
      if (trigger.kind === 'chunk_visited_new') this.pendingChunkVisitedNew = true;
      return;
    }
    const idx = goal.currentStepIdx;
    const step = goal.subGoals[idx];
    const check = step?.check;
    if (!check) return;
    let matched = false;
    if (check.type === 'action_performed' && trigger.kind === 'action_performed') {
      matched = check.value === trigger.value;
    } else if (check.type === 'inventory_has' && trigger.kind === 'inventory_changed') {
      matched = this.character.inventory.includes(check.item);
    } else if (check.type === 'chunk_visited_new' && trigger.kind === 'chunk_visited_new') {
      matched = true;
    }
    if (!matched) return;
    const updated = this.dailyGoalRepo.advanceStep(goal.id, idx);
    if (!updated) return;
    this.character.dailyGoal = updated;
    const stepLabel = `${idx + 1}/${goal.subGoals.length}`;
    if (updated.status === 'completed') {
      this.pushLog('pick', `daily-goal completed (auto:${check.type}, ${stepLabel}): ${goal.summary}`);
      this.logEvent('daily_goal_completed', { day: goal.day, summary: goal.summary, via: check.type });
    } else {
      this.pushLog('pick', `daily-goal step ${stepLabel} done (auto:${check.type})`);
      this.logEvent('daily_goal_step', {
        day: goal.day,
        stepIdx: idx,
        text: goal.subGoals[idx]?.text ?? '',
        via: check.type,
      });
    }
    // Chain through any subsequent steps whose check is already satisfied by
    // current state. Only inventory_has is state-checkable — chunk_visited_new
    // and action_performed need fresh events. Without this loop, an already-held
    // item would leave the next step stalled until an unrelated mutation fires.
    let cursor = this.character.dailyGoal;
    while (cursor && cursor.status === 'in_progress') {
      const nIdx = cursor.currentStepIdx;
      const nCheck = cursor.subGoals[nIdx]?.check;
      if (!nCheck || nCheck.type !== 'inventory_has') break;
      if (!this.character.inventory.includes(nCheck.item)) break;
      const next = this.dailyGoalRepo.advanceStep(cursor.id, nIdx);
      if (!next) break;
      this.character.dailyGoal = next;
      const lbl = `${nIdx + 1}/${next.subGoals.length}`;
      if (next.status === 'completed') {
        this.pushLog('pick', `daily-goal completed (auto:inventory_has(state), ${lbl}): ${goal.summary}`);
        this.logEvent('daily_goal_completed', { day: goal.day, summary: goal.summary, via: 'inventory_has_state' });
      } else {
        this.pushLog('pick', `daily-goal step ${lbl} done (auto:inventory_has(state))`);
        this.logEvent('daily_goal_step', {
          day: goal.day,
          stepIdx: nIdx,
          text: next.subGoals[nIdx]?.text ?? '',
          via: 'inventory_has_state',
        });
      }
      cursor = next;
    }
  }

  // Apply the LLM's self-tagged advance to the active daily goal. No-op when
  // the tags are absent, the index doesn't match the active step, or no goal
  // is in progress. Updates the in-memory character.dailyGoal so the next
  // tick's prompt + WS broadcast see the bump.
  private maybeAdvanceDailyGoal(
    advancesSubgoalIdx: number | null,
    completesSubgoal: boolean | null,
  ): void {
    if (!this.character) return;
    if (!completesSubgoal) return;
    if (advancesSubgoalIdx === null) return;
    const cur = this.character.dailyGoal;
    if (!cur || cur.status !== 'in_progress') return;
    if (advancesSubgoalIdx !== cur.currentStepIdx) return;
    const updated = this.dailyGoalRepo.advanceStep(cur.id, advancesSubgoalIdx);
    if (!updated) return;
    this.character.dailyGoal = updated;
    const stepLabel = `${advancesSubgoalIdx + 1}/${cur.subGoals.length}`;
    if (updated.status === 'completed') {
      this.pushLog('pick', `daily-goal completed (${stepLabel}): ${cur.summary}`);
      this.logEvent('daily_goal_completed', { day: cur.day, summary: cur.summary });
    } else {
      this.pushLog('pick', `daily-goal step ${stepLabel} done`);
      this.logEvent('daily_goal_step', {
        day: cur.day,
        stepIdx: advancesSubgoalIdx,
        text: cur.subGoals[advancesSubgoalIdx]?.text ?? '',
      });
    }
  }

  /** Admin: force daily-goal generation right now without waiting for the
   *  game-day boundary. Returns the goal once generation completes. */
  async triggerDailyGoalNow(): Promise<
    { ok: true; goal: import('../../shared/types.js').DailyGoal }
    | { ok: false; reason: string }
  > {
    if (!this.ollamaOptions) return { ok: false, reason: 'ollama not configured (UDU_AI_MODE != llm)' };
    if (!this.character) return { ok: false, reason: 'no live character' };
    if (this.dailyGoalInFlight) return { ok: false, reason: 'daily-goal already in flight' };
    const c = this.character;
    const opts = this.ollamaOptions;
    const known = Array.from(this.knownResources.values());
    const visits = Array.from(this.chunkVisits.values());
    const targetDay = this.gameTime().day;
    const yesterday = targetDay > 1
      ? this.dailyGoalRepo.loadForDay(c.id, targetDay - 1)
      : null;
    this.dailyGoalInFlight = true;
    try {
      const goal = await generateDailyGoal({
        character: c,
        lifeGoal: c.lifeGoal ?? null,
        knownResources: known,
        chunkVisits: visits,
        eventRepo: this.eventRepo,
        cachedRules: this.cachedRules,
        yesterdayGoal: yesterday,
        ollama: opts,
        gameDay: targetDay,
        repo: this.dailyGoalRepo,
        onLog: (line) => console.log(line),
      });
      if (!goal) return { ok: false, reason: 'LLM returned no valid plan' };
      if (this.character && this.character.id === c.id && this.character.isAlive) {
        this.character.dailyGoal = goal;
        this.pushLog('pick', `daily-goal D${goal.day} (${goal.alignment}): ${goal.summary}`);
        this.logEvent('daily_goal_set', {
          day: goal.day,
          alignment: goal.alignment,
          summary: goal.summary,
          steps: goal.subGoals.length,
        });
      }
      return { ok: true, goal };
    } finally {
      this.dailyGoalInFlight = false;
    }
  }

  /** Admin/inspection helper — exposes the active daily goal for /api/admin/daily-goal. */
  dailyGoalForAdmin(): import('../../shared/types.js').DailyGoal | null {
    if (!this.character) return null;
    return this.dailyGoalRepo.loadActive(this.character.id);
  }

  private executeFinal(action: Action): string | undefined {
    if (!this.character) return undefined;
    const s = this.character.stats;
    // Track precondition fails per-action — surfaced to the LLM as the
    // observation tail (eg "tree appears empty") so it doesn't keep retrying
    // a dead target. Set inside fail branches; left undefined on success.
    let failReason: string | undefined;
    switch (action.type) {
      case 'eat': {
        // Generic eat — target is the inventory item key.
        const item = action.target;
        if (!item) { failReason = 'eat missing target'; break; }
        const idx = this.character.inventory.indexOf(item);
        if (idx < 0) { failReason = `no ${item} in inventory`; break; }
        if (item === 'berry') {
          this.character.inventory.splice(idx, 1);
          s.hunger = clamp(s.hunger + NUTRITION.hungerPerBerry);
          s.energy = clamp(s.energy + NUTRITION.energyPerBerry);
        } else if (item === 'fruit') {
          this.character.inventory.splice(idx, 1);
          s.hunger = clamp(s.hunger + NUTRITION.hungerPerFruit);
          s.energy = clamp(s.energy + NUTRITION.energyPerFruit);
        } else if (item === 'meat_raw') {
          this.character.inventory.splice(idx, 1);
          s.hunger = clamp(s.hunger + NUTRITION.hungerPerMeatRaw);
          s.energy = clamp(s.energy + NUTRITION.energyPerMeatRaw);
          s.sickness = clamp((s.sickness ?? 0) + NUTRITION.sicknessPerMeatRaw);
        } else if (item === 'meat_cooked') {
          this.character.inventory.splice(idx, 1);
          s.hunger = clamp(s.hunger + NUTRITION.hungerPerMeatCooked);
          s.energy = clamp(s.energy + NUTRITION.energyPerMeatCooked);
        } else {
          failReason = `${item} is not edible`;
          break;
        }
        this.logEvent('eat', { item, hunger: s.hunger, energy: s.energy, invCount: this.character.inventory.length });
        break;
      }
      case 'shake': {
        const r = this.findResource(action.target);
        if (!r) { failReason = 'no source to shake'; break; }
        // Bush — burst harvest: all berries direct to inventory (no ground drop).
        if (r.type === 'bush') {
          const berries = Number(r.state?.berries ?? 0);
          if (berries <= 0) { failReason = 'bush appears empty'; break; }
          let picked = 0;
          for (let i = 0; i < berries; i++) {
            if (!canCarry(this.character.inventory, 'berry')) break;
            this.character.inventory.push('berry');
            picked++;
          }
          r.state = { ...r.state, berries: berries - picked };
          this.resourceRepo.persist(r);
          s.energy = clamp(s.energy - ACTION_COSTS.shakeTreeEnergy);
          this.logEvent('shake', { source: r.id, type: 'bush', picked });
          if (picked === 0) failReason = 'inventory too full to carry berries';
          break;
        }
        // Tree — per-shake: drop 1 item to ground per shake action.
        let stashKey: 'fruits' | 'branches' | 'vines';
        let groundType: 'fruit' | 'branch' | 'vine';
        let idPrefix: string;
        if (r.type === 'tree_fruit') {
          stashKey = 'fruits'; groundType = 'fruit'; idPrefix = 'fruit';
        } else if (r.type === 'tree_wood') {
          stashKey = 'branches'; groundType = 'branch'; idPrefix = 'branch';
        } else if (r.type === 'tree_vine') {
          stashKey = 'vines'; groundType = 'vine'; idPrefix = 'vine';
        } else {
          failReason = 'cannot shake that';
          break;
        }
        const stashCount = Number(r.state?.[stashKey] ?? 0);
        if (stashCount <= 0) { failReason = 'tree appears empty'; break; }
        r.state = { ...r.state, [stashKey]: stashCount - 1 };
        this.resourceRepo.persist(r);
        const id = `${idPrefix}_${++this.nextResourceId}`;
        const init = DROP_INIT.treeShake();
        const drop: Resource = {
          id, type: groundType, x: r.x, y: r.y, state: { source: r.id },
          z: init.z, vx: init.vx, vy: init.vy, vz: init.vz,
        };
        this.resources.push(drop);
        this.resourceRepo.persist(drop);
        s.energy = clamp(s.energy - ACTION_COSTS.shakeTreeEnergy);
        this.logEvent('shake', { source: r.id, type: r.type, dropped: 1 });
        break;
      }
      case 'pickup': {
        // Generic pickup — ground items only (bush/tree harvested via shake).
        // Proximity gate: char must be within PHYSICS_CONFIG.pickupRadius of the
        // item's continuous (x,y). Prevents teleport-pickup across tiles.
        const r = this.findResource(action.target);
        if (!r) { failReason = 'nothing here to pick up'; break; }
        let invKey: string;
        if (r.type === 'fruit') invKey = 'fruit';
        else if (r.type === 'branch') invKey = 'branch';
        else if (r.type === 'vine') invKey = 'vine';
        else if (r.type === 'stone') invKey = 'stone';
        else if (r.type === 'wood') invKey = 'wood';
        else if (r.type === 'berry') invKey = 'berry';
        else if (r.type === 'meat_raw') invKey = 'meat_raw';
        else if (r.type === 'meat_cooked') invKey = 'meat_cooked';
        else { failReason = 'cannot pick that up'; break; }
        const dx = this.character.position.x - r.x;
        const dy = this.character.position.y - r.y;
        if (Math.hypot(dx, dy) > PHYSICS_CONFIG.pickupRadius) {
          failReason = 'too far to pick up';
          break;
        }
        if (!canCarry(this.character.inventory, invKey)) {
          this.logEvent('pickup_skipped', { reason: 'inventory_full', item: invKey });
          failReason = `inventory too full to carry ${invKey}`;
          break;
        }
        this.character.inventory.push(invKey);
        this.removeResource(r.id);
        s.energy = clamp(s.energy - ACTION_COSTS.pickupEnergy);
        this.logEvent('pickup', { item: invKey, resource: r.id, invCount: this.character.inventory.length });
        this.evaluateDailyGoalCheck({ kind: 'inventory_changed' });
        break;
      }
      case 'drink': {
        s.thirst = clamp(s.thirst + NUTRITION.thirstPerDrink);
        s.energy = clamp(s.energy + NUTRITION.energyPerDrink);
        this.logEvent('drink', { thirst: s.thirst, energy: s.energy });
        break;
      }
      case 'defecate': {
        s.bladder = 0;
        s.energy = clamp(s.energy - ACTION_COSTS.defecateEnergy);
        this.logEvent('defecate', {});
        break;
      }
      case 'sleep': {
        this.character.currentAction = action;
        this.logEvent('sleep_start', { energy: s.energy });
        this.evaluateDailyGoalCheck({ kind: 'action_performed', value: 'sleep' });
        return;
      }
      case 'rest': {
        // Continuous passive — duration set when planRest fires. applyHourlyDecay
        // throttles drain via REST_CONFIG.decayMultiplier while action='rest'.
        this.character.currentAction = action;
        this.restEndsAtMs = Date.now()
          + REST_CONFIG.minDurationMs
          + Math.random() * (REST_CONFIG.maxDurationMs - REST_CONFIG.minDurationMs);
        this.logEvent('rest_start', { durationMs: (this.restEndsAtMs ?? Date.now()) - Date.now() });
        this.evaluateDailyGoalCheck({ kind: 'action_performed', value: 'rest' });
        return;
      }
      case 'hunt': {
        const animal = this.findResource(action.target);
        if (!animal) { failReason = 'no animal in range'; break; }
        if (animal.type !== 'animal_chicken' && animal.type !== 'animal_fish') {
          failReason = 'no animal in range';
          break;
        }
        if (!this.character.inventory.includes('wood')) {
          failReason = 'no wood to hunt with';
          break;
        }
        const ax = animal.x;
        const ay = animal.y;
        this.removeResource(animal.id);
        const meatId = `meat_raw_${++this.nextResourceId}`;
        const meatInit = DROP_INIT.hunt;
        const meatDrop: Resource = {
          id: meatId, type: 'meat_raw', x: ax, y: ay, state: { source: animal.id },
          z: meatInit.z, vx: meatInit.vx, vy: meatInit.vy, vz: meatInit.vz,
        };
        this.resources.push(meatDrop);
        this.resourceRepo.persist(meatDrop);
        s.energy = clamp(s.energy - ACTION_COSTS.huntEnergy);
        s.thirst = clamp(s.thirst - ACTION_COSTS.huntThirst);
        // Phase 3 — transformation auto-reveal. Char produced raw meat from
        // their own kill; full tag set is known immediately (no observe needed).
        this.revealGlossary('meat_raw');
        this.logEvent('hunt', {
          animal: animal.id,
          kind: animal.type,
          dropId: meatId,
        });
        break;
      }
      case 'drop': {
        // Drop one item of the targeted type from inventory. Spawns at char's
        // exact (x,y) with no offset — items can overlap. Picks up gravity-free
        // (manual init: z=0, all velocities 0).
        const itemType = action.target;
        if (!itemType) { failReason = 'drop missing target'; break; }
        const idx = this.character.inventory.indexOf(itemType);
        if (idx < 0) { failReason = `no ${itemType} to drop`; break; }
        this.character.inventory.splice(idx, 1);
        const dropId = `${itemType}_${++this.nextResourceId}`;
        const dropInit = DROP_INIT.manual;
        const droppedItem: Resource = {
          id: dropId,
          type: itemType as ResourceType,
          x: this.character.position.x,
          y: this.character.position.y,
          state: { source: 'manual_drop' },
          z: dropInit.z, vx: dropInit.vx, vy: dropInit.vy, vz: dropInit.vz,
        };
        this.resources.push(droppedItem);
        this.resourceRepo.persist(droppedItem);
        this.logEvent('drop', { item: itemType, dropId });
        this.evaluateDailyGoalCheck({ kind: 'inventory_changed' });
        break;
      }
      case 'add_fuel': {
        // Refuel the fire from inventory branch (Phase A.1) or legacy wood.
        // Must be adjacent (within FIRE_CONFIG.refuelRadius). Re-lights the
        // fire if it was extinguished. Capped at FIRE_CONFIG.maxFuel. Branch
        // and wood both feed +1 fuel — branch is the renewable supply since
        // chop_tree (raw wood) is gated behind axe (Phase B).
        const fire = this.findResource(action.target);
        if (!fire || fire.type !== 'fire') { failReason = 'no fire here'; break; }
        const dx = this.character.position.x - fire.x;
        const dy = this.character.position.y - fire.y;
        if (Math.hypot(dx, dy) > FIRE_CONFIG.refuelRadius + 0.5) {
          failReason = 'too far from fire to refuel';
          break;
        }
        let fuelIdx = this.character.inventory.indexOf('branch');
        let fuelItem = 'branch';
        if (fuelIdx < 0) {
          fuelIdx = this.character.inventory.indexOf('wood');
          fuelItem = 'wood';
        }
        if (fuelIdx < 0) { failReason = 'no fuel to add'; break; }
        this.character.inventory.splice(fuelIdx, 1);
        const currentFuel = typeof fire.state.fuel === 'number' ? fire.state.fuel : 0;
        const nextFuel = Math.min(FIRE_CONFIG.maxFuel, currentFuel + 1);
        fire.state = { ...fire.state, fuel: nextFuel, lit: true };
        this.resourceRepo.persist(fire);
        s.energy = clamp(s.energy - 0.5);
        this.logEvent('add_fuel', { fire: fire.id, fuel: nextFuel, lit: true, item: fuelItem });
        this.evaluateDailyGoalCheck({ kind: 'inventory_changed' });
        break;
      }
      case 'cook': {
        // Instant cook: meat_raw → meat_cooked, must be adjacent to a lit fire.
        // Per design lock 2026-04-27: instant, no fuel cost, only meat scope.
        const fire = this.findResource(action.target);
        if (!fire || fire.type !== 'fire') { failReason = 'no fire here'; break; }
        if (!fire.state?.lit) { failReason = 'fire not lit'; break; }
        const dx = this.character.position.x - fire.x;
        const dy = this.character.position.y - fire.y;
        if (Math.hypot(dx, dy) > FIRE_CONFIG.refuelRadius + 0.5) {
          failReason = 'too far from fire to cook';
          break;
        }
        const idx = this.character.inventory.indexOf('meat_raw');
        if (idx < 0) { failReason = 'no raw meat to cook'; break; }
        this.character.inventory[idx] = 'meat_cooked';
        s.energy = clamp(s.energy - ACTION_COSTS.cookMeatEnergy);
        // Phase 3 — cooking transforms raw → cooked; cooked is auto-known.
        this.revealGlossary('meat_cooked');
        this.logEvent('cook', { fire: fire.id, invCount: this.character.inventory.length });
        this.evaluateDailyGoalCheck({ kind: 'inventory_changed' });
        break;
      }
      case 'observe': {
        // Phase 3 — gateway action. Target is either a map resource id (look
        // up resource.type) or an inventory item key (use directly). For
        // edible/drinkable types the char eats/drinks in the same action so
        // the outcome (sickness or not) matches the revealed tag set. For
        // inedible-only types observe is a free no-op reveal.
        const target = action.target;
        if (!target) { failReason = 'observe missing target'; break; }

        let resourceType: string;
        let resource: Resource | null = null;
        let invIdx = -1;
        // Inventory keys (e.g. 'fruit', 'berry') are bare ResourceType names;
        // resource ids are unique with `_<num>` suffix. Try inventory first.
        invIdx = this.character.inventory.indexOf(target);
        if (invIdx >= 0) {
          resourceType = target;
        } else {
          resource = this.findResource(target);
          if (!resource) { failReason = 'cannot observe that'; break; }
          resourceType = resource.type;
          const dx = this.character.position.x - resource.x;
          const dy = this.character.position.y - resource.y;
          if (Math.hypot(dx, dy) > PHYSICS_CONFIG.pickupRadius + (resourceType === 'river' ? 0.5 : 0)) {
            failReason = 'too far to observe';
            break;
          }
        }

        const truth = RESOURCE_TRUTH[resourceType] ?? ['inedible'];
        const isEdible = truth.includes('edible');
        const isDrinkable = truth.includes('drinkable');

        if (isEdible) {
          // Consume the item — same nutrition path as eat. If from ground we
          // remove the resource; if from inventory we splice. Either way, one
          // unit gets consumed regardless of canCarry — observe must succeed.
          if (invIdx >= 0) {
            this.character.inventory.splice(invIdx, 1);
          } else if (resource) {
            this.removeResource(resource.id);
          }
          if (resourceType === 'fruit') {
            s.hunger = clamp(s.hunger + NUTRITION.hungerPerFruit);
            s.energy = clamp(s.energy + NUTRITION.energyPerFruit);
          } else if (resourceType === 'berry') {
            s.hunger = clamp(s.hunger + NUTRITION.hungerPerBerry);
            s.energy = clamp(s.energy + NUTRITION.energyPerBerry);
          } else if (resourceType === 'meat_raw') {
            s.hunger = clamp(s.hunger + NUTRITION.hungerPerMeatRaw);
            s.energy = clamp(s.energy + NUTRITION.energyPerMeatRaw);
            s.sickness = clamp((s.sickness ?? 0) + NUTRITION.sicknessPerMeatRaw);
          } else if (resourceType === 'meat_cooked') {
            s.hunger = clamp(s.hunger + NUTRITION.hungerPerMeatCooked);
            s.energy = clamp(s.energy + NUTRITION.energyPerMeatCooked);
          }
        } else if (isDrinkable) {
          // Drinkable observe = drink semantics.
          s.thirst = clamp(s.thirst + NUTRITION.thirstPerDrink);
          s.energy = clamp(s.energy + NUTRITION.energyPerDrink);
        }
        // Inedible-only: zero side effect, just reveal the tag below.

        const tags = Array.from(new Set(truth)).sort() as typeof truth;
        this.character.glossary[resourceType] = tags;
        this.glossaryRepo.upsert(this.character.id, resourceType, tags, Date.now());
        this.logEvent('observe', { target, type: resourceType, tags });
        this.evaluateDailyGoalCheck({ kind: 'inventory_changed' });
        break;
      }
      default:
        break;
    }
    this.evaluateDailyGoalCheck({ kind: 'action_performed', value: action.type });
    this.evaluateDailyGoalCheck({ kind: 'inventory_changed' });
    this.character.currentAction = { type: 'idle', startedAt: Date.now() };
    return failReason;
  }

  private applyTileDecay(tiles: number): void {
    if (!this.character || !this.character.isAlive) return;
    const s = this.character.stats;
    s.energy = clamp(s.energy - TILE_DECAY.energyPerTile * tiles);
    s.thirst = clamp(s.thirst - TILE_DECAY.thirstPerTile * tiles);
    s.hunger = clamp(s.hunger - TILE_DECAY.hungerPerTile * tiles);
  }

  private currentSpeedTilesPerSec(): number {
    const sick = this.character?.stats.sickness ?? 0;
    const base = AI_CONFIG.speedTilesPerSec;
    return sick > SICKNESS_CONFIG.slowMoveThreshold
      ? base * SICKNESS_CONFIG.slowMoveSpeedMultiplier
      : base;
  }

  private occupiedTiles(): Set<string> {
    const s = new Set<string>();
    for (const r of this.resources) s.add(`${r.x},${r.y}`);
    return s;
  }

  private findAdjacentFreeTile(from: Resource, occupied: Set<string>): Position | null {
    const { widthTiles, heightTiles } = MAP_CONFIG;
    const offsets = [
      { x: 1, y: 0 },
      { x: -1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ];
    // Shuffle offsets for variety.
    for (let i = offsets.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
    }
    for (const off of offsets) {
      const x = from.x + off.x;
      const y = from.y + off.y;
      if (x < 0 || y < 0 || x >= widthTiles || y >= heightTiles) continue;
      const key = `${x},${y}`;
      if (this.blocked.has(key)) continue;
      if (occupied.has(key)) continue;
      return { x, y };
    }
    return null;
  }

  private removeResource(id: string): void {
    const idx = this.resources.findIndex((r) => r.id === id);
    if (idx >= 0) this.resources.splice(idx, 1);
    this.resourceRepo.delete(id);
  }

  // Phase 3 — write a ResourceType's full truth to the char's glossary. Used
  // by transformation actions (hunt → meat_raw, cook → meat_cooked) where the
  // char produced the item themselves so they implicitly know its tags.
  private revealGlossary(type: string): void {
    if (!this.character) return;
    const truth = RESOURCE_TRUTH[type];
    if (!truth) return;
    if (this.character.glossary[type]) return;
    const tags = Array.from(new Set(truth)).sort() as typeof truth;
    this.character.glossary[type] = tags;
    this.glossaryRepo.upsert(this.character.id, type, tags, Date.now());
  }

  private findResource(id?: string): Resource | null {
    if (!id) return null;
    return this.resources.find((r) => r.id === id) ?? null;
  }

  private logEvent(type: string, payload: Record<string, unknown>): void {
    const t = this.gameTime();
    const stamp = `D${t.day}_${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`;
    this.eventRepo.log(this.character?.id ?? null, stamp, type, payload);
  }

  private pushLog(kind: AiLogKind, text: string): void {
    this.aiLog.unshift({
      t: Date.now(),
      gameTime: this.gameTime(),
      kind,
      text,
    });
    if (this.aiLog.length > GameLoop.AI_LOG_MAX) this.aiLog.length = GameLoop.AI_LOG_MAX;
  }

  stop(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
    if (this.character) this.repo.persist(this.character);
  }

  snapshot(): GameState {
    return {
      time: this.gameTime(),
      character: this.character,
      resources: this.resources,
      rules: [],
      recentEvents: [],
      aiLog: this.aiLog,
      visibleTiles: this.character ? Array.from(this.lastVisibleTiles) : undefined,
      exploredTiles: this.character ? Array.from(this.cumulativeExploredTiles) : undefined,
    };
  }

  /** Admin/E2E: dump the wander + feed option lists the AI sees right now,
   *  using the same enumeration helpers decide() uses. Lets a tester verify
   *  pre-emptive options (pee_now, warm_at_fire, drink_river, etc.) actually
   *  surface for the current character state without waiting for the LLM to
   *  pick them. */
  /**
   * Pure-LLM escape valve: build a random direction-wander plan when the LLM
   * has produced N consecutive invalid picks. Bypasses utility decide() — picks
   * uniformly among walkable WANDER_DIRS so the character physically moves,
   * which mutates rememberedSummary on the next cortex prompt and breaks
   * prompt-repeats-itself loops. Returns null if no walkable direction exists
   * (extremely rare — char fully boxed in).
   */
  private buildEscapeWanderResult(hints: WanderHints): DecideResult | null {
    if (!this.character) return null;
    const known = this.materializeKnownResources();
    const opts = enumerateWanderOptions(this.character, this.blocked, known, hints);
    const dirs = opts.filter((o) => o.kind !== 'stay' && o.path.length > 0);
    if (dirs.length === 0) return null;
    const pick = dirs[Math.floor(Math.random() * dirs.length)];
    return {
      plan: {
        path: pick.path,
        finalAction: { type: 'idle', startedAt: Date.now() },
      },
      source: 'rule',
      choice: 'escape_wander',
      reasoning: `Pure-LLM stuck (2 consecutive invalid picks) — forced random wander toward ${pick.kind}.`,
    };
  }

  debugOptions(): { wander: unknown[]; feed: unknown[] } | null {
    if (!this.character) return null;
    const known = this.materializeKnownResources();
    const lastSeenById = new Map<string, number>();
    for (const r of known) lastSeenById.set(r.id, this.knownResources.get(r.id)?.lastSeenT ?? 0);
    const wander = enumerateWanderOptions(
      this.character,
      this.blocked,
      known,
      { lastSeenById, chunkVisits: this.chunkVisits, nowMs: Date.now() },
    );
    const feed = enumerateFeedOptions(this.character, known, this.blocked);
    return {
      wander: wander.map((o) => ({
        kind: o.kind,
        dist: Number(o.distance.toFixed(1)),
        annotation: o.annotation,
        isUnexplored: o.isUnexplored,
        hasFinalAction: !!o.finalAction,
      })),
      feed: feed.map((o) => ({
        kind: o.kind,
        target: o.target ?? null,
        dist: Number(o.distance.toFixed(1)),
        annotation: o.annotation ?? null,
      })),
    };
  }

  private snapshotForObservation(): { hunger: number; thirst: number; energy: number; sickness: number; inv: string[] } {
    const c = this.character!;
    const s = c.stats;
    return {
      hunger: s.hunger,
      thirst: s.thirst,
      energy: s.energy,
      sickness: s.sickness ?? 0,
      inv: [...c.inventory],
    };
  }

  private recordObservation(
    action: Action,
    before: { hunger: number; thirst: number; energy: number; sickness: number; inv: string[] },
    failReason?: string,
  ): void {
    const c = this.character;
    if (!c) return;
    const s = c.stats;
    const sicknessNow = s.sickness ?? 0;
    const round1 = (n: number) => Math.round(n * 10) / 10;
    const dHunger = round1(s.hunger - before.hunger);
    const dThirst = round1(s.thirst - before.thirst);
    const dEnergy = round1(s.energy - before.energy);
    const dSickness = round1(sicknessNow - before.sickness);
    const invDelta = computeInvDelta(before.inv, c.inventory);
    const t = this.gameTime();
    const obs: Observation = {
      t: `D${t.day} ${String(t.hour).padStart(2, '0')}:${String(t.minute).padStart(2, '0')}`,
      action: c.lastChoice ?? action.type,
      target: action.target,
    };
    if (Math.abs(dHunger) >= 0.1) obs.dHunger = dHunger;
    if (Math.abs(dThirst) >= 0.1) obs.dThirst = dThirst;
    if (Math.abs(dEnergy) >= 0.1) obs.dEnergy = dEnergy;
    if (Math.abs(dSickness) >= 0.1) obs.dSickness = dSickness;
    if (invDelta) obs.inv = invDelta;
    if (failReason) obs.failReason = failReason;
    this.observations.push(obs);
    // 60 obs ≈ 1 game-hour of recent action/effect history at decide-tick =
    // 1-game-min cadence. Cover long-tail effects (sickness escalating ~hour
    // after raw meat, day-night patterns, resource respawn) that 30 missed.
    if (this.observations.length > 60) this.observations.shift();
  }

  private gameTime(): GameTime {
    const elapsedRealMs = Date.now() - this.startMs;
    const totalGameMinutes = Math.floor(elapsedRealMs / this.effectiveMsPerGameMinute());
    const day = Math.floor(totalGameMinutes / (TIME_CONFIG.gameHoursPerDay * TIME_CONFIG.gameMinutesPerHour)) + 1;
    const hourOfDay = Math.floor(totalGameMinutes / TIME_CONFIG.gameMinutesPerHour) % TIME_CONFIG.gameHoursPerDay;
    const minuteOfHour = totalGameMinutes % TIME_CONFIG.gameMinutesPerHour;
    return { day, hour: hourOfDay, minute: minuteOfHour };
  }

  private effectiveMsPerGameMinute(): number {
    return TIME_CONFIG.realMsPerGameMinute / this.timeMultiplier;
  }

  public getTimeMultiplier(): number {
    return this.timeMultiplier;
  }

  // Live-toggle game-time speed without producing a discontinuity. Computes the
  // current game-minutes elapsed, then rebases startMs so the new effective
  // ms-per-game-minute lands on the same game-time at "now".
  public setTimeMultiplier(m: number): void {
    if (!Number.isFinite(m) || m === this.timeMultiplier) return;
    const now = Date.now();
    const currentGameMinutes = (now - this.startMs) / this.effectiveMsPerGameMinute();
    this.timeMultiplier = m;
    this.startMs = now - currentGameMinutes * this.effectiveMsPerGameMinute();
  }

  public getCortexEnabled(): boolean {
    return this.cortexEnabled;
  }

  public setCortexEnabled(v: boolean): void {
    this.cortexEnabled = !!v;
  }
}

export const MAP_INFO = MAP_CONFIG;

function computeInvDelta(before: string[], after: string[]): string | undefined {
  const items = new Set([...before, ...after]);
  const parts: string[] = [];
  for (const item of items) {
    let b = 0;
    for (const x of before) if (x === item) b++;
    let a = 0;
    for (const x of after) if (x === item) a++;
    const n = a - b;
    if (n === 0) continue;
    const sign = n > 0 ? '+' : '';
    parts.push(`${sign}${n}${item}`);
  }
  return parts.length > 0 ? parts.join(',') : undefined;
}

function clamp(v: number): number {
  if (v < 0) return 0;
  if (v > 100) return 100;
  return v;
}

// Pick the choice strategy from env. UDU_AI_MODE=llm activates Ollama; anything
// else (including unset) keeps the deterministic rule ladder. The LLM picker
// always falls back to rule on any failure (timeout, parse error, invalid pick)
// so the character never freezes when Ollama is down.
function buildPicker(): ChoicePicker {
  const mode = (process.env.UDU_AI_MODE ?? 'rule').toLowerCase();
  const rule = new RuleBasedChoicePicker();
  if (mode !== 'llm') return rule;
  const opts = ollamaOptionsFromEnv();
  if (!opts) return rule;
  console.log(`[game-loop] LLM choice picker enabled — model=${opts.model} url=${opts.url}`);
  return new LlmChoicePicker(
    opts,
    rule,
    (line) => console.log(line),
  );
}

// Reflection runs separately from the choice picker — it always uses Ollama
// when the env says so, regardless of UDU_AI_MODE. (Reflecting with the
// rule-based picker would mean writing rules from rule-based behaviour, which
// has no learning signal.) Returns null when env hasn't been configured.
function ollamaOptionsFromEnv(): OllamaOptions | null {
  const mode = (process.env.UDU_AI_MODE ?? 'rule').toLowerCase();
  if (mode !== 'llm') return null;
  const url = process.env.OLLAMA_URL ?? 'http://172.21.160.1:11434';
  const model = process.env.OLLAMA_MODEL ?? 'qwen3:8b';
  return { url, model };
}
