import type { Action, Character, Glossary, Position, Resource, ResourceType } from '../../shared/types.js';
import { AI_CONFIG, FIRE_CONFIG, MAP_CONFIG, NUTRITION, REST_CONFIG, TEMPERATURE_CONFIG, THRESHOLDS, TIME_CONFIG, maskType, maskTarget } from '../../shared/config.js';
import { canCarry, weightOfItem } from '../../shared/inventory.js';
import { CIRCADIAN, currentPhase, type Phase } from '../../shared/circadian.js';
import { tileToChunk, chunkKey } from '../../shared/spatial.js';
import type { ChunkVisit } from './chunk-visit-repo.js';
import { findPath, hasLineOfSight, smoothPath } from './pathfinder.js';
import type { ChoicePicker, FeedOption, Observation, WanderKind, WanderOption, WorldStatus } from './llm/choice-picker.js';

// Extra context for the wander annotation layer. Threads remembered-resource
// staleness + chunk visit history into enumerateWanderOptions so the LLM can
// distinguish "old memory" from "fresh", and "never been there" from "barren
// area I keep wandering into". Without these the annotation collapses both
// distinctions into a flat "near_<type>" / "unexplored" pair.
export type WanderHints = {
  lastSeenById: Map<string, number>;
  chunkVisits: Map<string, ChunkVisit>;
  nowMs: number;
  // Circadian hints — feed the pre-emptive sleep option. Optional so legacy
  // call-sites (debug endpoint) keep working with default behaviour (no
  // pre-emptive sleep surfaced).
  phase?: Phase;
  nearLitFire?: boolean;
  // Pre-formatted game-time stamp ("D2 14:30") — cortex prompt surfaces it
  // so the LLM knows the in-game clock, not just the phase.
  gameTimeStamp?: string;
};

export type ActionPlan = {
  path: Position[];
  finalAction: Action;
};

// decide() now returns more than just the plan: when the feed branch went
// through the LLM picker we also surface the chosen kind + reasoning so
// game-loop can stamp them onto the character (visible in the dev HUD).
// advancesSubgoalIdx / completesSubgoal are LLM self-tags for the active
// daily-goal sub-step — game-loop calls DailyGoalRepo.advanceStep when both
// fields are present and completesSubgoal is true.
export type DecideResult = {
  plan: ActionPlan;
  choice?: string;
  reasoning?: string;
  source?: 'rule' | 'llm';
  advancesSubgoalIdx?: number | null;
  completesSubgoal?: boolean | null;
};

type Need = 'eat' | 'drink' | 'pee' | 'sleep';

// When hunger falls below this, character panic-eats raw meat or berry rather than cooking.
const DESPERATE_HUNGER = 15;

/**
 * Compute which tiles are blocked for A*. Bushes, trees, and river tiles block walking.
 * Animals, wood, and fire are walkable — character stands on same tile to interact.
 */
export function computeBlocked(resources: Resource[]): Set<string> {
  const blocked = new Set<string>();
  for (const r of resources) {
    if (
      r.type === 'bush' ||
      r.type === 'tree_fruit' ||
      r.type === 'tree_vine' ||
      r.type === 'tree_wood' ||
      r.type === 'boulder' ||
      r.type === 'river'
    ) {
      blocked.add(`${r.x},${r.y}`);
    }
  }
  return blocked;
}

/**
 * decide() takes only what the character has personally seen — knownResources
 * is the live projection of spatial memory onto current world state. The
 * `blocked` set still reflects full world geometry (so A* doesn't path through
 * trees the char hasn't memorised yet) but no planner reads `allResources`
 * directly. Effect: a freshly-spawned blind char has knownResources = [], all
 * planners return null, and we fall through to wander → pure exploration
 * until the vision cone scoops up something useful.
 */
export type DecideOptions = {
  suppressSleep?: boolean;
  // Phase + fire hints feed circadian sleep pull and pre-emptive sleep option.
  // `phase` derived from current game hour by caller (game-loop already owns
  // the gameTime clock); `nearLitFire` lifted from isCharNearLitFire().
  phase?: Phase;
  nearLitFire?: boolean;
};

export async function decide(
  character: Character,
  knownResources: Resource[],
  blocked: Set<string>,
  picker: ChoicePicker,
  observations: Observation[],
  rules: string[],
  wanderHints: WanderHints,
  options: DecideOptions = {},
): Promise<DecideResult | null> {
  const s = character.stats;
  const { suppressSleep = false, phase = 'afternoon', nearLitFire = false } = options;
  const sleepTrigger = CIRCADIAN.energySleepTrigger[phase];

  if (character.currentAction.type === 'sleep' && s.energy < AI_CONFIG.sleepWakeEnergy) {
    return null;
  }

  // Per-need trigger thresholds replace the old single urgencyThreshold. Each
  // need fires only when its stat crosses the trigger; this stops the loop of
  // "stat dipped 1 → immediately recover" that made the character feel
  // robotic. Picking the most urgent of the firing needs preserves the old
  // priority behaviour. Sleep trigger is now phase-aware so the char sleeps
  // earlier at night and pushes through during the day.
  const triggered: Array<{ need: Need; urgency: number }> = [];
  if (s.hunger <= THRESHOLDS.hungerTrigger) triggered.push({ need: 'eat', urgency: 100 - s.hunger });
  if (s.thirst <= THRESHOLDS.thirstTrigger) triggered.push({ need: 'drink', urgency: 100 - s.thirst });
  if (s.energy <= sleepTrigger && !suppressSleep) triggered.push({ need: 'sleep', urgency: 100 - s.energy });
  if (s.bladder >= THRESHOLDS.bladderTrigger) triggered.push({ need: 'pee', urgency: s.bladder });

  if (triggered.length === 0) {
    // No urgent need — opportunistic fire-tending first, then wood pickup,
    // then rest or wander. Refueling jumps the queue when fire is unlit or
    // running low and char has wood; matches "good steward" behavior.
    const fuelPlan = planAddFuel(character, knownResources, blocked);
    if (fuelPlan) return { plan: fuelPlan };
    const opportunistic = planPickupWood(character, knownResources, blocked);
    if (opportunistic) return { plan: opportunistic };
    // Rest is rare-by-design. Energy gate first: fresh/decent character
    // never sits. Then a tiny probability scaled by fatigue. With ceiling
    // 0.05 and gate 60, an energy-30 character rolls ~3.5% per decide tick.
    if (s.energy < REST_CONFIG.energyGate) {
      const restProb = (1 - s.energy / 100) * REST_CONFIG.maxProbability;
      if (Math.random() < restProb) return { plan: planRest() };
    }
    return await wanderWithChoice(character, blocked, picker, knownResources, wanderHints, observations);
  }

  // Try each triggered need in priority order. If the top-urgency planner
  // can't build a plan (e.g. defecate finds no reachable spot), fall through
  // to the next need rather than freezing the character.
  triggered.sort((a, b) => b.urgency - a.urgency);
  for (const t of triggered) {
    if (t.need === 'eat') {
      const r = await planFeed(character, knownResources, blocked, picker, observations, rules);
      if (r) return r;
    } else if (t.need === 'drink') {
      const p = planForage(character, knownResources, blocked, ['river']);
      if (p) return { plan: p };
    } else if (t.need === 'pee') {
      const p = planDefecate(character, blocked, knownResources);
      if (p) return { plan: p };
    } else if (t.need === 'sleep') {
      return { plan: { path: [], finalAction: { type: 'sleep', startedAt: Date.now() } } };
    }
  }
  // Every triggered need failed to plan. If energy is also low (woke from
  // sleep early due to hunger/thirst but nothing is reachable), go back to
  // sleep rather than wandering and draining energy further. This breaks the
  // thrash loop of: wake-for-hunger → planFeed fails → wander → energy→15 →
  // sleep → wake-for-hunger → repeat.
  if (s.energy <= sleepTrigger + 15) {
    return { plan: { path: [], finalAction: { type: 'sleep', startedAt: Date.now() } } };
  }
  // Route through wanderWithChoice so the LLM can steer toward areas likely
  // to satisfy the unmet need. Falls back to legacy wander when no directional
  // options are walkable (extreme tight spaces).
  return await wanderWithChoice(character, blocked, picker, knownResources, wanderHints, observations);
}

function planRest(): ActionPlan {
  // No path — character sits in place. game-loop.executeFinal('rest') sets the
  // duration window; ai.decide isn't called again until the rest ends or a
  // need crosses its trigger (handled outside this function — game-loop's
  // advanceAI returns early while currentAction === 'rest').
  return { path: [], finalAction: { type: 'rest', startedAt: Date.now() } };
}

/**
 * Feed planner — enumerates every reachable food option and hands them to a
 * ChoicePicker. Options carry only spatial info (kind/target/dist), no
 * mechanics. The LLM picker is expected to induce cause→effect from the
 * character's own observation log (Phase 4 design: action⇒reaction learned
 * from history, not spoon-fed in the prompt).
 */
async function planFeed(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
  picker: ChoicePicker,
  observations: Observation[],
  rules: string[],
): Promise<DecideResult | null> {
  const options = enumerateFeedOptions(character, resources, blocked);
  if (options.length === 0) return null;
  const world = computeWorldStatus(character, resources);
  const result = await picker.pickFeed({ character, options, observations, rules, world });
  if (!result) return null;
  return {
    plan: { path: result.option.path, finalAction: result.option.finalAction },
    choice: result.option.kind,
    reasoning: result.reasoning,
    source: result.source,
    advancesSubgoalIdx: result.advancesSubgoalIdx,
    completesSubgoal: result.completesSubgoal,
  };
}

/**
 * Build the full set of feed options the picker can choose from. Mirrors the
 * shape of the old planFeed ladder but emits every reachable option in
 * parallel rather than returning the first one. Cost annotations are
 * heuristics — the LLM uses them as hints, not source of truth (canonical
 * numbers live in NUTRITION/ACTION_COSTS).
 */
export function enumerateFeedOptions(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): FeedOption[] {
  const options: FeedOption[] = [];
  const inv = character.inventory;
  const s = character.stats;
  const hungerCritical = s.hunger <= DESPERATE_HUNGER;
  const start = character.position;
  // Phase 3 — glossary gate. Only surface options whose target ResourceType is
  // in the char's glossary. Map resources are pre-filtered so plans never
  // target unknowns; inventory consumes gate per-item.
  const known = (t: string): boolean => !!character.glossary[t];
  const knownRes = resources.filter((r) => known(r.type));

  // Helpers — clamped gain so "expected" reflects real benefit after the 0-100
  // cap. Sickness gain is capped at the remaining headroom too so raw meat
  // doesn't advertise +20sickness when sickness is already 95.
  const hungerGain = (raw: number) => Math.max(0, Math.min(raw, 100 - s.hunger));
  const energyGain = (raw: number) => Math.max(0, Math.min(raw, 100 - s.energy));
  const sicknessGain = (raw: number) => Math.max(0, Math.min(raw, 100 - (s.sickness ?? 0)));
  // capHint surfaces "(already X/100)" only when realized < raw — i.e. the cap
  // bit. Lets the LLM see diminishing return without spoiler text.
  const capHint = (realized: number, raw: number, current: number): string =>
    realized < raw ? ` (already ${Math.round(current)}/100)` : '';

  // Phase 3 follow-up — generic verbs everywhere. `kind` is the universal
  // capability ("eat", "shake"), `target` carries the specific item type or
  // masked source id. Picker matches kind+target. Inv eat targets are bare
  // type names (gated by glossary so always known); map source/item targets
  // are masked via maskTarget so unknown subtypes collapse to parent label
  // (`tree_fruit_5` → `tree_5`) before hitting the LLM.
  const g = character.glossary;

  // From-inventory eats — distance 0, no walk. Inv items are gated by known()
  // so the type name in target is safe (LLM already knows it).
  if (inv.includes('meat_cooked') && known('meat_cooked')) {
    const dh = hungerGain(NUTRITION.hungerPerMeatCooked);
    const de = energyGain(NUTRITION.energyPerMeatCooked);
    options.push({
      kind: 'eat',
      target: 'meat_cooked',
      path: [],
      distance: 0,
      finalAction: { type: 'eat', target: 'meat_cooked', startedAt: Date.now() },
      annotation: `expected=+${dh.toFixed(0)}hunger,+${de.toFixed(0)}energy${capHint(dh, NUTRITION.hungerPerMeatCooked, s.hunger)}`,
    });
  }

  if (inv.includes('meat_raw') && known('meat_raw')) {
    const dh = hungerGain(NUTRITION.hungerPerMeatRaw);
    const ds = sicknessGain(NUTRITION.sicknessPerMeatRaw);
    const cap = capHint(dh, NUTRITION.hungerPerMeatRaw, s.hunger);
    const rawAnnot = hungerCritical
      ? `panic expected=+${dh.toFixed(0)}hunger,+${ds.toFixed(0)}sickness${cap}`
      : `expected=+${dh.toFixed(0)}hunger,+${ds.toFixed(0)}sickness${cap}`;
    options.push({
      kind: 'eat',
      target: 'meat_raw',
      path: [],
      distance: 0,
      finalAction: { type: 'eat', target: 'meat_raw', startedAt: Date.now() },
      annotation: rawAnnot,
    });
    const cookPlan = planCook(character, resources, blocked);
    if (cookPlan) {
      options.push({
        kind: 'cook',
        target: cookPlan.finalAction.target ? maskTarget(cookPlan.finalAction.target, g) : undefined,
        path: cookPlan.path,
        distance: pathDistance(start, cookPlan.path),
        finalAction: cookPlan.finalAction,
      });
    }
  }

  if (inv.includes('berry') && known('berry')) {
    const dh = hungerGain(NUTRITION.hungerPerBerry);
    options.push({
      kind: 'eat',
      target: 'berry',
      path: [],
      distance: 0,
      finalAction: { type: 'eat', target: 'berry', startedAt: Date.now() },
      annotation: `expected=+${dh.toFixed(0)}hunger${capHint(dh, NUTRITION.hungerPerBerry, s.hunger)}`,
    });
  }
  if (inv.includes('fruit') && known('fruit')) {
    const dh = hungerGain(NUTRITION.hungerPerFruit);
    options.push({
      kind: 'eat',
      target: 'fruit',
      path: [],
      distance: 0,
      finalAction: { type: 'eat', target: 'fruit', startedAt: Date.now() },
      annotation: `expected=+${dh.toFixed(0)}hunger${capHint(dh, NUTRITION.hungerPerFruit, s.hunger)}`,
    });
  }

  // Hunt — only available with wood in inventory AND at least one animal
  // subtype the char has observed (gen 0 doesn't even know what an animal is).
  if (inv.includes('wood')) {
    const huntPlan = planHunt(character, knownRes, blocked);
    if (huntPlan) {
      options.push({
        kind: 'hunt',
        target: huntPlan.finalAction.target ? maskTarget(huntPlan.finalAction.target, g) : undefined,
        path: huntPlan.path,
        distance: pathDistance(start, huntPlan.path),
        finalAction: huntPlan.finalAction,
      });
    }
  }

  if (known('fruit')) {
    const fgPlan = planPickupFruitGround(character, knownRes, blocked);
    if (fgPlan) {
      options.push({
        kind: 'pickup',
        target: fgPlan.finalAction.target ? maskTarget(fgPlan.finalAction.target, g) : undefined,
        path: fgPlan.path,
        distance: pathDistance(start, fgPlan.path),
        finalAction: fgPlan.finalAction,
      });
    }
  }

  if (known('bush')) {
    const bushPlan = planForageOf(character, knownRes, blocked, 'bush');
    if (bushPlan) {
      options.push({
        kind: 'shake',
        target: bushPlan.finalAction.target ? maskTarget(bushPlan.finalAction.target, g) : undefined,
        path: bushPlan.path,
        distance: pathDistance(start, bushPlan.path),
        finalAction: bushPlan.finalAction,
      });
    }
  }

  if (known('tree_fruit')) {
    const treePlan = planForageOf(character, knownRes, blocked, 'tree_fruit');
    if (treePlan) {
      options.push({
        kind: 'shake',
        target: treePlan.finalAction.target ? maskTarget(treePlan.finalAction.target, g) : undefined,
        path: treePlan.path,
        distance: pathDistance(start, treePlan.path),
        finalAction: treePlan.finalAction,
      });
    }
  }

  if (!inv.includes('wood') && known('wood')) {
    const wPlan = planPickupWood(character, knownRes, blocked);
    if (wPlan) {
      options.push({
        kind: 'pickup',
        target: wPlan.finalAction.target ? maskTarget(wPlan.finalAction.target, g) : undefined,
        path: wPlan.path,
        distance: pathDistance(start, wPlan.path),
        finalAction: wPlan.finalAction,
      });
    }
  }

  return options;
}

function pathDistance(start: Position, path: Position[]): number {
  if (path.length === 0) return 0;
  let total = Math.hypot(path[0].x - start.x, path[0].y - start.y);
  for (let i = 1; i < path.length; i++) {
    total += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  }
  return total;
}

function planPickupFruitGround(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  if (!canCarry(character.inventory, 'fruit')) return null;
  const fruits = resources.filter((r) => r.type === 'fruit');
  let best: { path: Position[]; fruit: Resource } | null = null;
  for (const f of fruits) {
    const path = findPath(character.position, [{ x: Math.floor(f.x), y: Math.floor(f.y) }], blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, fruit: f };
  }
  if (!best) return null;
  const smoothed = smoothPath(character.position, best.path, blocked);
  const jx = (Math.random() - 0.5) * 0.5;
  const jy = (Math.random() - 0.5) * 0.5;
  const floatPath = smoothed.length === 0
    ? smoothed
    : [...smoothed.slice(0, -1), { x: best.fruit.x + jx, y: best.fruit.y + jy }];
  return {
    path: floatPath,
    finalAction: { type: 'pickup', target: best.fruit.id, startedAt: Date.now() },
  };
}

function planForageOf(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
  type: 'bush' | 'tree_fruit' | 'tree_vine' | 'tree_wood',
): ActionPlan | null {
  // Bush picks straight to inventory (berry); tree shakes drop the stash item
  // on the ground (uncapped) — only the bush path needs an inventory weight gate.
  if (type === 'bush' && !canCarry(character.inventory, 'berry')) return null;
  const stashKey =
    type === 'bush' ? 'berries'
      : type === 'tree_fruit' ? 'fruits'
        : type === 'tree_vine' ? 'vines'
          : 'branches';
  const candidates = resources.filter((r) => {
    if (r.type !== type) return false;
    return Number(r.state?.[stashKey] ?? 0) > 0;
  });
  if (candidates.length === 0) return null;

  let best: { path: Position[]; target: Resource } | null = null;
  for (const r of candidates) {
    const goals = adjacentTiles(r, blocked);
    if (goals.length === 0) continue;
    const path = findPath(character.position, goals, blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, target: r };
  }
  if (!best) return null;

  const finalType: Action['type'] = 'shake';
  const smoothed = smoothPath(character.position, best.path, blocked);
  return {
    path: applyOrganicStop(smoothed, best.target, character.position, blocked),
    finalAction: { type: finalType, target: best.target.id, startedAt: Date.now() },
  };
}

function planCook(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  const fires = resources.filter((r) => r.type === 'fire');
  let best: { path: Position[]; fire: Resource } | null = null;
  for (const f of fires) {
    const goals = adjacentTiles(f, blocked);
    if (goals.length === 0) continue;
    const path = findPath(character.position, goals, blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, fire: f };
  }
  if (!best) return null;
  const smoothed = smoothPath(character.position, best.path, blocked);
  return {
    path: applyOrganicStop(smoothed, best.fire, character.position, blocked),
    finalAction: { type: 'cook', target: best.fire.id, startedAt: Date.now() },
  };
}

function planHunt(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  if (!canCarry(character.inventory, 'meat_raw')) return null;
  const animals = resources.filter(
    (r) => r.type === 'animal_chicken' || r.type === 'animal_fish',
  );
  let best: { path: Position[]; target: Resource } | null = null;
  for (const a of animals) {
    const goals = adjacentTiles(a, blocked);
    if (goals.length === 0) continue;
    const path = findPath(character.position, goals, blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, target: a };
  }
  if (!best) return null;
  const smoothed = smoothPath(character.position, best.path, blocked);
  return {
    path: applyOrganicStop(smoothed, best.target, character.position, blocked),
    finalAction: { type: 'hunt', target: best.target.id, startedAt: Date.now() },
  };
}

// Build a world-status snapshot for the LLM prompts. Currently this is just
// the nearest fire's fuel + lit state + integer tile distance from the char.
// Returns `{ fireStatus: null }` when no fire exists on the map (defensive —
// the seed always spawns one, but lineages may shift later).
function computeWorldStatus(character: Character, resources: readonly Resource[]): WorldStatus {
  const fires = resources.filter((r) => r.type === 'fire');
  if (fires.length === 0) return { fireStatus: null };
  let nearest: { fire: Resource; dist: number } | null = null;
  for (const f of fires) {
    const d = Math.hypot(character.position.x - f.x, character.position.y - f.y);
    if (!nearest || d < nearest.dist) nearest = { fire: f, dist: d };
  }
  if (!nearest) return { fireStatus: null };
  const fuel = typeof nearest.fire.state.fuel === 'number'
    ? nearest.fire.state.fuel
    : FIRE_CONFIG.maxFuel;
  const lit = nearest.fire.state.lit !== false;
  const status = `Fire: ${fuel}/${FIRE_CONFIG.maxFuel} wood, ${lit ? 'lit' : 'unlit'}, ${Math.round(nearest.dist)} tiles away`;
  return { fireStatus: status };
}

// Strategic refuel: if char carries branch or wood and the fire is unlit or
// running below half capacity, walk to the fire and feed it. Branch is the
// primary post-A.1 fuel; wood remains valid (legacy spawns + future chop).
function planAddFuel(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  if (!character.inventory.includes('branch') && !character.inventory.includes('wood')) return null;
  const fires = resources.filter((r) => r.type === 'fire');
  if (fires.length === 0) return null;

  let best: { path: Position[]; fire: Resource } | null = null;
  for (const f of fires) {
    const fuel = typeof f.state.fuel === 'number' ? f.state.fuel : FIRE_CONFIG.maxFuel;
    const lit = f.state.lit !== false;
    const needsRefuel = !lit || fuel < FIRE_CONFIG.maxFuel / 2;
    if (!needsRefuel) continue;
    const goals = adjacentTiles(f, blocked);
    if (goals.length === 0) continue;
    const path = findPath(character.position, goals, blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, fire: f };
  }
  if (!best) return null;
  const smoothed = smoothPath(character.position, best.path, blocked);
  return {
    path: applyOrganicStop(smoothed, best.fire, character.position, blocked),
    finalAction: { type: 'add_fuel', target: best.fire.id, startedAt: Date.now() },
  };
}

function planPickupWood(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  return planPickupGroundItem(character, resources, blocked, 'wood', 'wood');
}

function planPickupBranch(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  return planPickupGroundItem(character, resources, blocked, 'branch', 'branch');
}

function planPickupVine(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  return planPickupGroundItem(character, resources, blocked, 'vine', 'vine');
}

function planPickupStone(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  return planPickupGroundItem(character, resources, blocked, 'stone', 'stone');
}


function planPickupGroundItem(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
  resourceType: ResourceType,
  invItem: string,
): ActionPlan | null {
  if (!canCarry(character.inventory, invItem)) return null;
  const candidates = resources.filter((r) => r.type === resourceType);
  let best: { path: Position[]; target: Resource } | null = null;
  for (const c of candidates) {
    const path = findPath(character.position, [{ x: Math.floor(c.x), y: Math.floor(c.y) }], blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, target: c };
  }
  if (!best) return null;
  const smoothed = smoothPath(character.position, best.path, blocked);
  const jx = (Math.random() - 0.5) * 0.5;
  const jy = (Math.random() - 0.5) * 0.5;
  const floatPath = smoothed.length === 0
    ? smoothed
    : [...smoothed.slice(0, -1), { x: best.target.x + jx, y: best.target.y + jy }];
  return {
    path: floatPath,
    finalAction: { type: 'pickup', target: best.target.id, startedAt: Date.now() },
  };
}

function planForage(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
  wantedTypes: Array<'river'>,
): ActionPlan | null {
  const candidates = resources.filter((r) => wantedTypes.includes(r.type as 'river'));
  if (candidates.length === 0) return null;

  let best: { path: Position[]; target: Resource } | null = null;
  for (const r of candidates) {
    const goals = adjacentTiles(r, blocked);
    if (goals.length === 0) continue;
    const path = findPath(character.position, goals, blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, target: r };
  }
  if (!best) return null;

  const smoothed = smoothPath(character.position, best.path, blocked);
  return {
    path: applyOrganicStop(smoothed, best.target, character.position, blocked),
    finalAction: { type: 'drink', target: best.target.id, startedAt: Date.now() },
  };
}

function planDefecate(
  character: Character,
  blocked: Set<string>,
  resources: Resource[],
): ActionPlan | null {
  const riverTiles = resources.filter((r) => r.type === 'river');
  const nearRiver = (x: number, y: number): boolean =>
    riverTiles.some((r) => Math.abs(r.x - x) + Math.abs(r.y - y) <= 2);

  const { widthTiles, heightTiles } = MAP_CONFIG;
  const { wanderRadius } = AI_CONFIG;
  const cx = Math.round(character.position.x);
  const cy = Math.round(character.position.y);

  // Iterate candidates by ascending distance and try findPath on each. Old
  // version picked one random spot and returned null on a single A* failure —
  // when the local neighbourhood was crowded (forest biome + river constraint)
  // that left the character permanently unable to relieve itself.
  const tryRadius = (radius: number, allowNearRiver: boolean): ActionPlan | null => {
    const candidates: Position[] = [];
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= widthTiles || y >= heightTiles) continue;
        if (blocked.has(`${x},${y}`)) continue;
        if (!allowNearRiver && nearRiver(x, y)) continue;
        candidates.push({ x, y });
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort(
      (a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
    );
    for (const spot of candidates) {
      const path = findPath(character.position, [spot], blocked);
      if (path === null) continue;
      const smoothed = smoothPath(character.position, path, blocked);
      // Jitter the final destination off-grid so the character crouches anywhere in the tile.
      const jitterX = (Math.random() - 0.5) * 0.6;
      const jitterY = (Math.random() - 0.5) * 0.6;
      const floatPath = [
        ...smoothed.slice(0, -1),
        { x: spot.x + jitterX, y: spot.y + jitterY },
      ];
      return {
        path: floatPath,
        finalAction: { type: 'defecate', startedAt: Date.now() },
      };
    }
    return null;
  };

  // Strict first (preferred), then progressively relax: bigger radius, then
  // allow near-river when nothing else works. Survival > etiquette.
  return (
    tryRadius(wanderRadius, false) ??
    tryRadius(wanderRadius * 2, false) ??
    tryRadius(wanderRadius, true) ??
    tryRadius(wanderRadius * 2, true)
  );
}

function wander(character: Character, blocked: Set<string>): ActionPlan | null {
  const { widthTiles, heightTiles } = MAP_CONFIG;
  const { wanderRadius } = AI_CONFIG;
  for (let attempt = 0; attempt < 20; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = 1 + Math.random() * wanderRadius;
    const tx = character.position.x + Math.cos(angle) * dist;
    const ty = character.position.y + Math.sin(angle) * dist;
    if (tx < 0.5 || ty < 0.5 || tx > widthTiles - 1.5 || ty > heightTiles - 1.5) continue;
    const gx = Math.round(tx);
    const gy = Math.round(ty);
    if (blocked.has(`${gx},${gy}`)) continue;
    const path = findPath(character.position, [{ x: gx, y: gy }], blocked);
    if (!path || path.length === 0) continue;
    const smoothed = smoothPath(character.position, path, blocked);
    // Replace the final grid waypoint with the actual random float point.
    const floatPath = [...smoothed.slice(0, -1), { x: tx, y: ty }];
    return {
      path: floatPath,
      finalAction: { type: 'wander', startedAt: Date.now() },
    };
  }
  return null;
}

// 8 cardinal/ordinal direction vectors plus stay. Engine casts a ray per
// direction up to WANDER_RAY_LEN tiles, takes the furthest walkable tile as
// the option's target. Annotations are derived from spatial memory so the
// LLM can reason about exploration vs revisit.
const WANDER_DIRS: Array<{ kind: WanderKind; dx: number; dy: number }> = [
  { kind: 'wander_n', dx: 0, dy: -1 },
  { kind: 'wander_ne', dx: 1, dy: -1 },
  { kind: 'wander_e', dx: 1, dy: 0 },
  { kind: 'wander_se', dx: 1, dy: 1 },
  { kind: 'wander_s', dx: 0, dy: 1 },
  { kind: 'wander_sw', dx: -1, dy: 1 },
  { kind: 'wander_w', dx: -1, dy: 0 },
  { kind: 'wander_nw', dx: -1, dy: -1 },
];
const WANDER_RAY_LEN = 10;
const WANDER_NEAR_RADIUS = 4;

export function enumerateWanderOptions(
  character: Character,
  blocked: Set<string>,
  knownResources: Resource[],
  hints: WanderHints,
): WanderOption[] {
  const start = character.position;
  const { widthTiles, heightTiles } = MAP_CONFIG;
  const opts: WanderOption[] = [];

  for (const d of WANDER_DIRS) {
    let lastWalkable: Position | null = null;
    for (let step = 1; step <= WANDER_RAY_LEN; step++) {
      const x = Math.round(start.x + d.dx * step);
      const y = Math.round(start.y + d.dy * step);
      if (x < 0 || y < 0 || x >= widthTiles || y >= heightTiles) break;
      if (blocked.has(`${x},${y}`)) break;
      lastWalkable = { x, y };
    }
    if (!lastWalkable) continue;
    const dist = Math.hypot(lastWalkable.x - start.x, lastWalkable.y - start.y);
    if (dist < 2) continue;
    const path = findPath(start, [lastWalkable], blocked);
    if (!path || path.length === 0) continue;
    const ann = annotateWanderTarget(lastWalkable, knownResources, widthTiles, heightTiles, hints, character.glossary);
    opts.push({
      kind: d.kind,
      target: lastWalkable,
      path,
      distance: dist,
      annotation: ann.text,
      isUnexplored: ann.unexplored,
    });
  }

  opts.push({
    kind: 'stay',
    target: { x: start.x, y: start.y },
    path: [],
    distance: 0,
    annotation: 'at_pos',
    isUnexplored: false,
  });

  // Pre-emptive consume options — let the LLM decide to eat/drink before
  // hunger/thirst cross the safety-net threshold. Path/distance match the
  // movement cost: eat-from-inventory is in-place (path=[]), drink walks to
  // the river first. Each option carries an `expected=+Nstat` annotation:
  // the actual stat gain after clamp at 100, so the LLM can see "expected=+0"
  // when char is full and skip the redundant pick. Without this, qwen3:8b
  // observed picking drink_river 30+ times in a row at thirst=100 ("drinking
  // is not needed... however..."), reasoning contradicting choice.
  const inv = character.inventory;
  const s = character.stats;
  // Phase 3 — glossary gate. Pre-emptive eat/pickup/shake are only surfaced
  // when char knows the relevant ResourceType.
  const known = (t: string): boolean => !!character.glossary[t];
  const knownRes = knownResources.filter((r) => known(r.type));
  // capHint surfaces "(already X/100)" only when realized < raw. Same shape as
  // the feed-enumerator helper.
  const capHint = (realized: number, raw: number, current: number): string =>
    realized < raw ? ` (already ${Math.round(current)}/100)` : '';
  const berryCount = inv.filter((i) => i === 'berry').length;
  if (berryCount > 0 && known('berry')) {
    const gain = Math.max(0, Math.min(NUTRITION.hungerPerBerry, 100 - s.hunger));
    opts.push({
      kind: 'eat',
      // Inv eat: target carries the bare type name. Gated by known() so always
      // safe — if the LLM sees this option, the type is in glossary.
      target: { x: start.x, y: start.y },
      path: [],
      distance: 0,
      annotation: `inv=${berryCount}berry expected=+${gain.toFixed(0)}hunger${capHint(gain, NUTRITION.hungerPerBerry, s.hunger)}`,
      isUnexplored: false,
      finalAction: { type: 'eat', target: 'berry', startedAt: Date.now() },
    });
  }
  const fruitCount = inv.filter((i) => i === 'fruit').length;
  if (fruitCount > 0 && known('fruit')) {
    const gain = Math.max(0, Math.min(NUTRITION.hungerPerFruit, 100 - s.hunger));
    opts.push({
      kind: 'eat',
      target: { x: start.x, y: start.y },
      path: [],
      distance: 0,
      annotation: `inv=${fruitCount}fruit expected=+${gain.toFixed(0)}hunger${capHint(gain, NUTRITION.hungerPerFruit, s.hunger)}`,
      isUnexplored: false,
      finalAction: { type: 'eat', target: 'fruit', startedAt: Date.now() },
    });
  }

  // Drop options — surface 'drop' verb per unique inventory item so the LLM
  // can free up weight when it wants to pick up something else (e.g. carrying
  // max wood prevents berry pickup; drop wood opens capacity). Drops vanish
  // (no on-ground spawn) for now. One option = one drop; LLM repeats to drop
  // multiple.
  // Phase 3 follow-up — generic kind 'drop'; finalAction.target carries the
  // bare type name (gated by known() so always safe to expose).
  const seenInvTypes = new Set<string>();
  for (const item of inv) {
    if (seenInvTypes.has(item)) continue;
    seenInvTypes.add(item);
    if (!known(item)) continue;
    const count = inv.filter((i) => i === item).length;
    const w = weightOfItem(item);
    opts.push({
      kind: 'drop',
      target: { x: start.x, y: start.y },
      path: [],
      distance: 0,
      annotation: `inv=${count}${item} weight=${(w * count).toFixed(1)} drops 1`,
      isUnexplored: false,
      finalAction: { type: 'drop', target: item, startedAt: Date.now() },
    });
  }

  // Drink option — surfaces whenever a river is reachable. Annotation includes
  // expected thirst gain so the LLM can self-skip when thirst is already full.
  // River is auto-known (BASIC_KNOWN_TYPES) so drink is always available.
  const drinkPlan = planForage(character, knownRes, blocked, ['river']);
  if (drinkPlan) {
    const dist = drinkPlan.path.length;
    const gain = Math.max(0, Math.min(NUTRITION.thirstPerDrink, 100 - s.thirst));
    opts.push({
      kind: 'drink',
      target:
        drinkPlan.path.length > 0
          ? drinkPlan.path[drinkPlan.path.length - 1]
          : { x: start.x, y: start.y },
      path: drinkPlan.path,
      distance: dist,
      annotation: `river dist=${dist}t expected=+${gain.toFixed(0)}thirst${capHint(gain, NUTRITION.thirstPerDrink, s.thirst)}`,
      isUnexplored: false,
      finalAction: drinkPlan.finalAction,
    });
  }

  // Pee — always surfaced when a spot is reachable. Annotation includes current
  // bladder so the LLM can self-skip when fresh.
  {
    const peePlan = planDefecate(character, blocked, knownResources);
    if (peePlan) {
      opts.push({
        kind: 'defecate',
        target:
          peePlan.path.length > 0
            ? peePlan.path[peePlan.path.length - 1]
            : { x: start.x, y: start.y },
        path: peePlan.path,
        distance: peePlan.path.length,
        annotation: `bladder=${Math.round(s.bladder)} expected=-${Math.round(s.bladder)}bladder`,
        isUnexplored: false,
        finalAction: peePlan.finalAction,
      });
    }
  }

  // Warm-at-fire — surfaces whenever a lit fire is reachable. Walks to the
  // adjacent tile (inside FIRE_CONFIG.warmthRadius=3) and rests there; warmth
  // override drifts body temp toward fireWarmthAmbient. Annotation includes
  // current body temp so the LLM can self-skip when comfortable.
  // Fire is auto-known (BASIC_KNOWN_TYPES).
  {
    const warmPlan = planWarmAtFire(character, knownRes, blocked);
    if (warmPlan) {
      opts.push({
        kind: 'rest',
        target:
          warmPlan.path.length > 0
            ? warmPlan.path[warmPlan.path.length - 1]
            : { x: start.x, y: start.y },
        path: warmPlan.path,
        distance: warmPlan.path.length,
        annotation: `body=${Math.round(s.temperature)}C expected=ambient${TEMPERATURE_CONFIG.fireWarmthAmbient}C`,
        isUnexplored: false,
        finalAction: warmPlan.finalAction,
      });
    }
  }

  // Pre-emptive sleep — surface whenever it's night AND char is standing in a
  // lit fire's warmth radius (physical prereq for the "sleep efficiently next
  // to fire" variant). Sleep recovery is ×1.8 at night, awake decay is ×1.5,
  // both pull the same way. Annotation includes current energy so the LLM can
  // self-skip when fresh.
  if (hints.phase === 'night' && hints.nearLitFire) {
    opts.push({
      kind: 'sleep',
      target: { x: start.x, y: start.y },
      path: [],
      distance: 0,
      annotation: `night recovery=×1.8 energy=${Math.round(s.energy)}`,
      isUnexplored: false,
      finalAction: { type: 'sleep', startedAt: Date.now() },
    });
  }

  // Pickup-wood / pickup_branch — fire-fuel pickups. Both surface when fire is
  // unlit or low AND char can carry the item. Branch is the primary fuel post-A.1
  // (lighter than wood, drops from tree_wood); legacy wood ground items survive
  // until the schema reset clears them. Listed both so the LLM picks proximity.
  // Phase 3 — pickup gates also require glossary on the loose-item type.
  const fireNeedsFuel = knownRes.some((r) => {
    if (r.type !== 'fire') return false;
    const fuel = typeof r.state.fuel === 'number' ? r.state.fuel : FIRE_CONFIG.maxFuel;
    const lit = r.state.lit !== false;
    return !lit || fuel < FIRE_CONFIG.maxFuel / 2;
  });
  if (fireNeedsFuel && canCarry(character.inventory, 'wood') && known('wood')) {
    const wPlan = planPickupWood(character, knownRes, blocked);
    if (wPlan) {
      const dist = pathDistance(start, wPlan.path);
      opts.push({
        kind: 'pickup',
        target: wPlan.path.length > 0 ? wPlan.path[wPlan.path.length - 1] : start,
        path: wPlan.path,
        distance: dist,
        annotation: `fire=low dist=${Math.round(dist)}t`,
        isUnexplored: false,
        finalAction: wPlan.finalAction,
      });
    }
  }
  if (fireNeedsFuel && canCarry(character.inventory, 'branch') && known('branch')) {
    const bPlan = planPickupBranch(character, knownRes, blocked);
    if (bPlan) {
      const dist = pathDistance(start, bPlan.path);
      opts.push({
        kind: 'pickup',
        target: bPlan.path.length > 0 ? bPlan.path[bPlan.path.length - 1] : start,
        path: bPlan.path,
        distance: dist,
        annotation: `fire=low dist=${Math.round(dist)}t`,
        isUnexplored: false,
        finalAction: bPlan.finalAction,
      });
    }
  }

  // Add-fuel — tend a fire that's unlit or below half fuel. Surfaces when
  // char carries known fuel (branch or wood) AND a fire needing fuel is
  // reachable. Walks into refuel radius and dumps one piece. Annotation
  // surfaces only perceptual facts (lit state, fuel level, distance, item
  // consumed) so the LLM induces cause→effect (re-lit, fuel rose) from its
  // observation log rather than mechanic copy.
  {
    const fuelItem: 'branch' | 'wood' | null = inv.includes('branch')
      ? 'branch'
      : inv.includes('wood')
        ? 'wood'
        : null;
    if (fuelItem && known(fuelItem)) {
      const fuelPlan = planAddFuel(character, knownRes, blocked);
      if (fuelPlan) {
        const fireId = fuelPlan.finalAction.target;
        const fire = knownResources.find((r) => r.id === fireId);
        const fuel = typeof fire?.state.fuel === 'number' ? fire.state.fuel : 0;
        const lit = fire?.state.lit !== false;
        const dist = pathDistance(start, fuelPlan.path);
        opts.push({
          kind: 'add_fuel',
          target:
            fuelPlan.path.length > 0
              ? fuelPlan.path[fuelPlan.path.length - 1]
              : { x: start.x, y: start.y },
          path: fuelPlan.path,
          distance: dist,
          annotation: `fire=${lit ? 'lit' : 'unlit'} fuel=${fuel}/${FIRE_CONFIG.maxFuel} dist=${Math.round(dist)}t inv=1${fuelItem}`,
          isUnexplored: false,
          finalAction: fuelPlan.finalAction,
        });
      }
    }
  }

  // Pickup-vine — always surface when reachable + carry capacity. No urgent
  // gate; vine is a future-craft material so the LLM is free to stockpile or
  // ignore as it sees fit.
  if (canCarry(character.inventory, 'vine') && known('vine')) {
    const vPlan = planPickupVine(character, knownRes, blocked);
    if (vPlan) {
      const dist = pathDistance(start, vPlan.path);
      opts.push({
        kind: 'pickup',
        target: vPlan.path.length > 0 ? vPlan.path[vPlan.path.length - 1] : start,
        path: vPlan.path,
        distance: dist,
        annotation: `dist=${Math.round(dist)}t`,
        isUnexplored: false,
        finalAction: vPlan.finalAction,
      });
    }
  }

  // Pickup-stone — free stones lying around. No urgent gate; like vine, future
  // craft material (axe in Phase B).
  if (canCarry(character.inventory, 'stone') && known('stone')) {
    const sPlan = planPickupStone(character, knownRes, blocked);
    if (sPlan) {
      const dist = pathDistance(start, sPlan.path);
      opts.push({
        kind: 'pickup',
        target: sPlan.path.length > 0 ? sPlan.path[sPlan.path.length - 1] : start,
        path: sPlan.path,
        distance: dist,
        annotation: `dist=${Math.round(dist)}t`,
        isUnexplored: false,
        finalAction: sPlan.finalAction,
      });
    }
  }


  // Shake tree_wood / tree_vine — non-food shake variants. Force-drop alongside
  // the passive auto-drop loop. tree_fruit shake stays in feed enumerate.
  if (known('tree_wood')) {
    const shakeWoodPlan = planForageOf(character, knownRes, blocked, 'tree_wood');
    if (shakeWoodPlan) {
      const dist = pathDistance(start, shakeWoodPlan.path);
      opts.push({
        kind: 'shake',
        target: shakeWoodPlan.path.length > 0 ? shakeWoodPlan.path[shakeWoodPlan.path.length - 1] : start,
        path: shakeWoodPlan.path,
        distance: dist,
        annotation: `dist=${Math.round(dist)}t`,
        isUnexplored: false,
        finalAction: shakeWoodPlan.finalAction,
      });
    }
  }
  if (known('tree_vine')) {
    const shakeVinePlan = planForageOf(character, knownRes, blocked, 'tree_vine');
    if (shakeVinePlan) {
      const dist = pathDistance(start, shakeVinePlan.path);
      opts.push({
        kind: 'shake',
        target: shakeVinePlan.path.length > 0 ? shakeVinePlan.path[shakeVinePlan.path.length - 1] : start,
        path: shakeVinePlan.path,
        distance: dist,
        annotation: `dist=${Math.round(dist)}t`,
        isUnexplored: false,
        finalAction: shakeVinePlan.finalAction,
      });
    }
  }

  return opts;
}

// Walk to a lit fire so the warmth override applies. Picks the nearest fire
// the char can reach an adjacent tile of; final action is `rest` so the char
// stays in the warmth radius rather than wandering off the next tick.
function planWarmAtFire(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  const fires = resources.filter((r) => r.type === 'fire' && r.state.lit !== false);
  if (fires.length === 0) return null;
  let best: { path: Position[]; fire: Resource } | null = null;
  for (const f of fires) {
    const goals = adjacentTiles(f, blocked);
    if (goals.length === 0) continue;
    const path = findPath(character.position, goals, blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, fire: f };
  }
  if (!best) return null;
  const smoothed = smoothPath(character.position, best.path, blocked);
  return {
    path: applyOrganicStop(smoothed, best.fire, character.position, blocked),
    finalAction: { type: 'rest', startedAt: Date.now() },
  };
}

// Convert wall-clock ms delta to game-hours so the LLM reasoning aligns with
// in-game time it sees elsewhere (TIME_CONFIG: 1 real-min = 1 game-hour).
function msToGameHours(ms: number): number {
  return ms / (TIME_CONFIG.realMsPerGameMinute * TIME_CONFIG.gameMinutesPerHour);
}

function annotateWanderTarget(
  tgt: Position,
  known: Resource[],
  w: number,
  h: number,
  hints: WanderHints,
  glossary: Glossary,
): { text: string; unexplored: boolean } {
  // Composition + staleness — count remembered resources by type within
  // WANDER_NEAR_RADIUS of the target tile, take the freshest lastSeenT among
  // them as the "age" annotation. The LLM uses this to decide whether to trust
  // its memory ("seen 1h ago" vs "seen 12h ago — might've regrown/depleted").
  // Phase 3 — type names masked via glossary so unobserved subtypes collapse
  // to 'tree' / 'animal' / 'unknown_thing'.
  const byType: Record<string, number> = {};
  let mostRecentLastSeen = -Infinity;
  for (const r of known) {
    const d = Math.hypot(r.x - tgt.x, r.y - tgt.y);
    if (d > WANDER_NEAR_RADIUS) continue;
    const m = maskType(r.type, glossary);
    byType[m] = (byType[m] ?? 0) + 1;
    const last = hints.lastSeenById.get(r.id);
    if (last !== undefined && last > mostRecentLastSeen) mostRecentLastSeen = last;
  }

  // Chunk visit status — separate exploration axis from resource composition.
  // Old code conflated "no resources nearby" with "unexplored", so a barren
  // chunk visited 10 times kept reading as virgin territory.
  const { cx, cy } = tileToChunk(tgt.x, tgt.y);
  const visit = hints.chunkVisits.get(chunkKey(cx, cy));
  const visitTag = visit
    ? `visited=${visit.visitCount}`
    : 'unvisited';
  const chunkUnexplored = !visit;

  const tags: string[] = [];

  // Composition tag: bushx3+treex1 if anything remembered, else "nothing"
  const composition = Object.entries(byType)
    .map(([t, n]) => (n === 1 ? t : `${t}x${n}`))
    .join('+');
  if (composition) {
    tags.push(composition);
    const ageH = msToGameHours(hints.nowMs - mostRecentLastSeen);
    tags.push(`age=${ageH < 1 ? '<1' : Math.round(ageH)}h`);
  } else {
    tags.push('nothing');
  }

  tags.push(visitTag);

  const edgeDist = Math.min(tgt.x, tgt.y, w - 1 - tgt.x, h - 1 - tgt.y);
  if (edgeDist <= 2) tags.push('edge');

  return { text: tags.join(','), unexplored: chunkUnexplored };
}

async function wanderWithChoice(
  character: Character,
  blocked: Set<string>,
  picker: ChoicePicker,
  knownResources: Resource[],
  hints: WanderHints,
  observations: Observation[],
): Promise<DecideResult | null> {
  const options = enumerateWanderOptions(character, blocked, knownResources, hints);
  // Engine couldn't enumerate any directional options (extremely tight space)
  // — drop back to the legacy random wander so the character still moves.
  if (options.length <= 1) {
    const w = wander(character, blocked);
    return w ? { plan: w } : null;
  }
  const summary = summarizeRemembered(knownResources, character.glossary);
  const world = computeWorldStatus(character, knownResources);
  const result = await picker.pickWander({ character, options, rememberedSummary: summary, world, observations });
  if (!result) {
    const w = wander(character, blocked);
    return w ? { plan: w } : null;
  }
  if (result.option.kind === 'stay') {
    // LLM decided to rest in place — surface as a rest action with the same
    // reasoning so the dev panel sees why the char paused.
    return {
      plan: { path: [], finalAction: { type: 'rest', startedAt: Date.now() } },
      choice: result.option.kind,
      reasoning: result.reasoning,
      source: result.source,
      advancesSubgoalIdx: result.advancesSubgoalIdx,
      completesSubgoal: result.completesSubgoal,
    };
  }
  // Pre-emptive consume picks carry a finalAction (eat_berry / eat_fruit /
  // drink) attached to the option. Honour it instead of the default wander
  // movement so the LLM can top up before survival thresholds fire.
  if (result.option.finalAction) {
    const path = result.option.path.length > 0
      ? smoothPath(character.position, result.option.path, blocked)
      : [];
    return {
      plan: { path, finalAction: { ...result.option.finalAction, startedAt: Date.now() } },
      choice: result.option.kind,
      reasoning: result.reasoning,
      source: result.source,
      advancesSubgoalIdx: result.advancesSubgoalIdx,
      completesSubgoal: result.completesSubgoal,
    };
  }
  const smoothed = smoothPath(character.position, result.option.path, blocked);
  return {
    plan: { path: smoothed, finalAction: { type: 'wander', startedAt: Date.now() } },
    choice: result.option.kind,
    reasoning: result.reasoning,
    source: result.source,
    advancesSubgoalIdx: result.advancesSubgoalIdx,
    completesSubgoal: result.completesSubgoal,
  };
}

function summarizeRemembered(known: Resource[], glossary: Glossary): string {
  if (known.length === 0) return 'nothing (blank memory)';
  // Phase 3 — collapse via glossary mask. Unknown subtypes group as
  // 'unknown_thing'; tree_* / animal_* fold into 'tree' / 'animal' until
  // observed. Char must commit to observe before the prompt can render the
  // real type.
  const byType: Record<string, number> = {};
  for (const r of known) {
    const m = maskType(r.type, glossary);
    byType[m] = (byType[m] ?? 0) + 1;
  }
  return Object.entries(byType)
    .map(([t, n]) => `${n} ${t}${n > 1 ? 's' : ''}`)
    .join(', ');
}

/**
 * Replace the last (adjacent-tile) waypoint with a float stop-point at a random angle around
 * the resource. No axis-alignment — character stands anywhere on a ring of radius stopOffset.
 * Retries until the stop tile is unblocked and reachable from the approach tile in a straight line.
 */
function applyOrganicStop(
  path: Position[],
  resource: { x: number; y: number },
  charStart: Position,
  blocked: Set<string>,
): Position[] {
  const approach = path.length > 0 ? path[path.length - 1] : charStart;
  const offset = AI_CONFIG.stopOffsetTiles;
  const { widthTiles, heightTiles } = MAP_CONFIG;

  let fallback: Position | null = null;
  for (let attempt = 0; attempt < 16; attempt++) {
    const angle = Math.random() * Math.PI * 2;
    const stop: Position = {
      x: resource.x + Math.cos(angle) * offset,
      y: resource.y + Math.sin(angle) * offset,
    };
    if (stop.x < 0.5 || stop.y < 0.5 || stop.x > widthTiles - 1.5 || stop.y > heightTiles - 1.5) continue;
    const key = `${Math.round(stop.x)},${Math.round(stop.y)}`;
    if (blocked.has(key)) continue;
    if (!fallback) fallback = stop;
    if (hasLineOfSight(approach, stop, blocked)) {
      return path.length === 0 ? [stop] : [...path.slice(0, -1), stop];
    }
  }
  if (fallback) {
    return path.length === 0 ? [fallback] : [...path.slice(0, -1), fallback];
  }
  return path;
}

function adjacentTiles(r: Resource, blocked: Set<string>): Position[] {
  const { widthTiles, heightTiles } = MAP_CONFIG;
  const neighbors: Position[] = [
    { x: r.x + 1, y: r.y },
    { x: r.x - 1, y: r.y },
    { x: r.x, y: r.y + 1 },
    { x: r.x, y: r.y - 1 },
  ];
  return neighbors.filter(
    (p) =>
      p.x >= 0 && p.y >= 0 && p.x < widthTiles && p.y < heightTiles && !blocked.has(`${p.x},${p.y}`),
  );
}

// ---------------------------------------------------------------------------
// Cortex — full LLM-driven decision-making.
//
// The legacy decide() flow uses utility AI to detect WHICH need is firing
// (hunger trigger, thirst trigger, energy trigger, etc.) and only then asks
// the LLM to pick from a narrow option list scoped to that need. Cortex
// flips it: present the LLM with a flat menu of every action it could take
// this turn (feed + wander direction + maintenance + sleep + rest) and let
// it decide what matters. Utility AI stays in the codebase as the fallback
// when the LLM call fails or returns an invalid pick.
//
// Knowledge sources for the LLM are deliberately limited (Phase 4 fidelity):
// stat scale + survival principles (values, not tactics) + observation log +
// inherited lessons + life/daily goal. No mechanic disclosure.
// ---------------------------------------------------------------------------

export type CortexOption = {
  kind: string; // FeedKind | WanderKind | 'sleep'
  target?: string;
  path: Position[];
  distance: number;
  annotation?: string;
  finalAction: Action;
};

export function enumerateCortexOptions(
  character: Character,
  knownResources: Resource[],
  blocked: Set<string>,
  hints: WanderHints,
  suppressSleep: boolean = false,
): CortexOption[] {
  // Phase 3 follow-up — kinds are generic verbs ('eat', 'shake', 'pickup'…).
  // A single verb can have many target instances (eat berry vs eat meat_raw,
  // shake bush_5 vs shake tree_3) so dedup keys on the (kind|target) pair —
  // not the bare kind, which would collapse them all.
  const g = character.glossary;
  const seenPairs = new Set<string>();
  const dedupKey = (kind: string, target: string | undefined) => `${kind}|${target ?? ''}`;
  const opts: CortexOption[] = [];

  // Feed options first — they have rich finalActions (eat / cook / hunt /
  // shake / pickup). FeedOption.target is already masked (set by the
  // enumerator via maskTarget), so it can flow straight to CortexOption.target.
  for (const f of enumerateFeedOptions(character, knownResources, blocked)) {
    const key = dedupKey(f.kind, f.target);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    opts.push({
      kind: f.kind,
      target: f.target,
      path: f.path,
      distance: f.distance,
      annotation: f.annotation,
      finalAction: f.finalAction,
    });
  }

  // Wander options second — direction picks, plus maintenance/consume/stay.
  // Stay maps to a rest action (sit in place). Direction kinds get a synthetic
  // 'idle' finalAction so game-loop walks the path then idles.
  // WanderOption.target is a Position (movement target) so we can't reuse it
  // for the LLM-facing identifier — derive that from finalAction.target via
  // maskTarget so unknown subtypes collapse to the parent label.
  for (const w of enumerateWanderOptions(character, blocked, knownResources, hints)) {
    const wanderTarget =
      w.finalAction?.target !== undefined ? maskTarget(w.finalAction.target, g) : undefined;
    const key = dedupKey(w.kind, wanderTarget);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    let finalAction: Action;
    if (w.kind === 'stay') {
      finalAction = { type: 'rest', startedAt: Date.now() };
    } else if (w.finalAction) {
      finalAction = { ...w.finalAction, startedAt: Date.now() };
    } else {
      finalAction = { type: 'idle', startedAt: Date.now() };
    }
    opts.push({
      kind: w.kind,
      target: wanderTarget,
      path: w.path,
      distance: w.distance,
      annotation: w.annotation,
      finalAction,
    });
  }

  // Unconditional sleep — wander's conditional sleep surfaces only at night
  // near a lit fire (favourable conditions). This is the always-available
  // variant so the LLM can choose to nap whenever it wants.
  // Suppressed during wakeForNeed cooldown so the cortex can't immediately
  // re-pick sleep and bounce against the wake trigger (sleep⇄idle loop).
  const sleepKey = dedupKey('sleep', undefined);
  if (!suppressSleep && !seenPairs.has(sleepKey)) {
    seenPairs.add(sleepKey);
    opts.push({
      kind: 'sleep',
      path: [],
      distance: 0,
      annotation: `energy=${Math.round(character.stats.energy)}`,
      finalAction: { type: 'sleep', startedAt: Date.now() },
    });
  }

  // Phase 3 — observe options for unknown resource types. One option per
  // unknown type the char can reach (closest reachable instance picked).
  // Inventory unknowns get their own option (no walk required).
  // Opaque kind/target so the type name never leaks via the prompt — picker
  // matches on the same opaque pair, finalAction.target carries the real id
  // for game-loop dispatch.
  for (const obs of enumerateObserveOptions(character, knownResources, blocked)) {
    const key = dedupKey(obs.opaqueKind, obs.opaqueTarget);
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);
    opts.push({
      kind: obs.opaqueKind,
      target: obs.opaqueTarget,
      path: obs.path,
      distance: obs.distance,
      annotation: obs.annotation,
      finalAction: { type: 'observe', target: obs.realTarget, startedAt: Date.now() },
    });
  }

  return opts;
}

// Phase 3 — pick observe targets for unknown ResourceTypes the char has seen
// or carries. Returns at most one option per type (closest reachable instance).
// Char's glossary determines what's "unknown". Inventory items always observable.
// Phase 3 follow-up — kind is now the generic verb 'observe'; opaque target
// counter (`t1`/`t2`/…) disambiguates between multiple unknown things without
// leaking type names. Annotation surfaces only the masked label (`tree`,
// `animal`, or `unknown_thing`). Real id stays on `realTarget` for dispatch.
type ObserveOption = {
  opaqueKind: string;
  opaqueTarget: string;
  realTarget: string;
  path: Position[];
  distance: number;
  annotation: string;
};
function enumerateObserveOptions(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ObserveOption[] {
  const known = character.glossary ?? {};
  const out: ObserveOption[] = [];
  const seen = new Set<string>();
  let counter = 0;
  const nextOpaque = (): string => `t${++counter}`;

  // Inventory unknowns — instant observe (no walk).
  for (const inv of character.inventory) {
    if (known[inv]) continue;
    if (seen.has(inv)) continue;
    seen.add(inv);
    out.push({
      opaqueKind: 'observe',
      opaqueTarget: nextOpaque(),
      realTarget: inv,
      path: [],
      distance: 0,
      annotation: `inv ${maskType(inv, known)}`,
    });
  }

  // Map unknowns — group by type, pick closest reachable per type.
  const byType = new Map<string, Resource[]>();
  for (const r of resources) {
    if (known[r.type]) continue;
    if (!byType.has(r.type)) byType.set(r.type, []);
    byType.get(r.type)!.push(r);
  }
  for (const [type, list] of byType) {
    if (seen.has(type)) continue;
    let best: { res: Resource; path: Position[] } | null = null;
    for (const r of list) {
      const path = findPath(character.position, [{ x: Math.floor(r.x), y: Math.floor(r.y) }], blocked);
      if (path === null) continue;
      if (!best || path.length < best.path.length) best = { res: r, path };
    }
    if (!best) continue;
    seen.add(type);
    out.push({
      opaqueKind: 'observe',
      opaqueTarget: nextOpaque(),
      realTarget: best.res.id,
      path: best.path,
      distance: best.path.length,
      annotation: `at(${Math.floor(best.res.x)},${Math.floor(best.res.y)}) ${maskType(type, known)}`,
    });
  }

  return out;
}

export async function cortexDecide(
  character: Character,
  knownResources: Resource[],
  blocked: Set<string>,
  picker: ChoicePicker,
  observations: Observation[],
  rules: string[],
  wanderHints: WanderHints,
  fallbackOptions: DecideOptions = {},
): Promise<DecideResult | null> {
  const options = enumerateCortexOptions(
    character,
    knownResources,
    blocked,
    wanderHints,
    fallbackOptions.suppressSleep ?? false,
  );
  if (options.length === 0 || !picker.pickCortex) {
    // Pure-LLM mode: no fallback to utility decide(). If options are empty or
    // the picker can't run cortex, return null and let the game-loop idle one
    // tick — next decide cycle retries. RuleBasedChoicePicker / utility
    // decide() remain in the tree as reference, just not in the live path.
    return null;
  }
  const world = computeWorldStatus(character, knownResources);
  const remembered = summarizeRemembered(knownResources, character.glossary);
  const phase = wanderHints.phase ?? 'afternoon';
  const gameTimeStamp = wanderHints.gameTimeStamp ?? '';

  const result = await picker.pickCortex({
    character,
    options,
    observations,
    rules,
    world,
    rememberedSummary: remembered,
    phase,
    gameTimeStamp,
  });
  if (!result) {
    // Pure-LLM mode: LLM failed/timeout/invalid pick — return null so the
    // game-loop idles this tick. Next decide cycle retries the LLM.
    return null;
  }
  const picked = result.option;
  return {
    plan: { path: picked.path, finalAction: picked.finalAction },
    choice: picked.kind,
    reasoning: result.reasoning,
    source: result.source,
    advancesSubgoalIdx: result.advancesSubgoalIdx,
    completesSubgoal: result.completesSubgoal,
  };
}
