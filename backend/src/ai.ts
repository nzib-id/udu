import type { Action, Character, Position, Resource } from '../../shared/types.js';
import { AI_CONFIG, MAP_CONFIG, REST_CONFIG, THRESHOLDS, TIME_CONFIG } from '../../shared/config.js';
import { tileToChunk, chunkKey } from '../../shared/spatial.js';
import type { ChunkVisit } from './chunk-visit-repo.js';
import { findPath, hasLineOfSight, smoothPath } from './pathfinder.js';
import type { ChoicePicker, FeedOption, Observation, WanderKind, WanderOption } from './llm/choice-picker.js';

// Extra context for the wander annotation layer. Threads remembered-resource
// staleness + chunk visit history into enumerateWanderOptions so the LLM can
// distinguish "old memory" from "fresh", and "never been there" from "barren
// area I keep wandering into". Without these the annotation collapses both
// distinctions into a flat "near_<type>" / "unexplored" pair.
export type WanderHints = {
  lastSeenById: Map<string, number>;
  chunkVisits: Map<string, ChunkVisit>;
  nowMs: number;
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
    if (r.type === 'bush' || r.type === 'tree' || r.type === 'river') {
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
export async function decide(
  character: Character,
  knownResources: Resource[],
  blocked: Set<string>,
  picker: ChoicePicker,
  observations: Observation[],
  rules: string[],
  wanderHints: WanderHints,
): Promise<DecideResult | null> {
  const s = character.stats;

  if (character.currentAction.type === 'sleep' && s.energy < AI_CONFIG.sleepWakeEnergy) {
    return null;
  }

  // Per-need trigger thresholds replace the old single urgencyThreshold. Each
  // need fires only when its stat crosses the trigger; this stops the loop of
  // "stat dipped 1 → immediately recover" that made the character feel
  // robotic. Picking the most urgent of the firing needs preserves the old
  // priority behaviour.
  const triggered: Array<{ need: Need; urgency: number }> = [];
  if (s.hunger <= THRESHOLDS.hungerTrigger) triggered.push({ need: 'eat', urgency: 100 - s.hunger });
  if (s.thirst <= THRESHOLDS.thirstTrigger) triggered.push({ need: 'drink', urgency: 100 - s.thirst });
  if (s.energy <= THRESHOLDS.energyTrigger) triggered.push({ need: 'sleep', urgency: 100 - s.energy });
  if (s.bladder >= THRESHOLDS.bladderTrigger) triggered.push({ need: 'pee', urgency: s.bladder });

  if (triggered.length === 0) {
    // No urgent need — opportunistic wood pickup, otherwise rest or wander.
    const opportunistic = planPickupWood(character, knownResources, blocked);
    if (opportunistic) return { plan: opportunistic };
    // Rest is rare-by-design. Energy gate first: fresh/decent character
    // never sits. Then a tiny probability scaled by fatigue. With ceiling
    // 0.05 and gate 60, an energy-30 character rolls ~3.5% per decide tick.
    if (s.energy < REST_CONFIG.energyGate) {
      const restProb = (1 - s.energy / 100) * REST_CONFIG.maxProbability;
      if (Math.random() < restProb) return { plan: planRest() };
    }
    return await wanderWithChoice(character, blocked, picker, knownResources, wanderHints);
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
  // Every triggered need failed to plan — route through wanderWithChoice so
  // the LLM can steer toward areas likely to satisfy the unmet need, instead
  // of random rule-only wander. wanderWithChoice itself falls back to legacy
  // wander when no directional options are walkable (extreme tight spaces).
  return await wanderWithChoice(character, blocked, picker, knownResources, wanderHints);
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
  const result = await picker.pickFeed({ character, options, observations, rules });
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
  const hungerCritical = character.stats.hunger <= DESPERATE_HUNGER;
  const start = character.position;

  // From-inventory eats — distance 0, no walk.
  if (inv.includes('meat_cooked')) {
    options.push({
      kind: 'eat_meat_cooked',
      path: [],
      distance: 0,
      finalAction: { type: 'eat_meat', target: 'cooked', startedAt: Date.now() },
    });
  }

  if (inv.includes('meat_raw')) {
    if (hungerCritical) {
      options.push({
        kind: 'eat_meat_raw_panic',
        path: [],
        distance: 0,
        finalAction: { type: 'eat_meat', target: 'raw', startedAt: Date.now() },
      });
    } else {
      options.push({
        kind: 'eat_meat_raw_normal',
        path: [],
        distance: 0,
        finalAction: { type: 'eat_meat', target: 'raw', startedAt: Date.now() },
      });
    }
    const cookPlan = planCook(character, resources, blocked);
    if (cookPlan) {
      options.push({
        kind: 'cook_meat',
        target: cookPlan.finalAction.target,
        path: cookPlan.path,
        distance: pathDistance(start, cookPlan.path),
        finalAction: cookPlan.finalAction,
      });
    }
  }

  if (inv.includes('berry')) {
    options.push({
      kind: 'eat_berry_inv',
      path: [],
      distance: 0,
      finalAction: { type: 'eat_berry', startedAt: Date.now() },
    });
  }
  if (inv.includes('fruit')) {
    options.push({
      kind: 'eat_fruit_inv',
      path: [],
      distance: 0,
      finalAction: { type: 'eat_fruit', startedAt: Date.now() },
    });
  }

  // Hunt — only available with wood in inventory.
  if (inv.includes('wood')) {
    const huntPlan = planHunt(character, resources, blocked);
    if (huntPlan) {
      options.push({
        kind: 'hunt',
        target: huntPlan.finalAction.target,
        path: huntPlan.path,
        distance: pathDistance(start, huntPlan.path),
        finalAction: huntPlan.finalAction,
      });
    }
  }

  const fgPlan = planPickupFruitGround(character, resources, blocked);
  if (fgPlan) {
    options.push({
      kind: 'pickup_fruit_ground',
      target: fgPlan.finalAction.target,
      path: fgPlan.path,
      distance: pathDistance(start, fgPlan.path),
      finalAction: fgPlan.finalAction,
    });
  }

  const bushPlan = planForageOf(character, resources, blocked, 'bush');
  if (bushPlan) {
    options.push({
      kind: 'forage_bush',
      target: bushPlan.finalAction.target,
      path: bushPlan.path,
      distance: pathDistance(start, bushPlan.path),
      finalAction: bushPlan.finalAction,
    });
  }

  const treePlan = planForageOf(character, resources, blocked, 'tree');
  if (treePlan) {
    options.push({
      kind: 'shake_tree',
      target: treePlan.finalAction.target,
      path: treePlan.path,
      distance: pathDistance(start, treePlan.path),
      finalAction: treePlan.finalAction,
    });
  }

  if (!inv.includes('wood')) {
    const wPlan = planPickupWood(character, resources, blocked);
    if (wPlan) {
      options.push({
        kind: 'pickup_wood',
        target: wPlan.finalAction.target,
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
  const fruits = resources.filter((r) => r.type === 'fruit_on_ground');
  let best: { path: Position[]; fruit: Resource } | null = null;
  for (const f of fruits) {
    const path = findPath(character.position, [{ x: f.x, y: f.y }], blocked);
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
    finalAction: { type: 'pickup_fruit_ground', target: best.fruit.id, startedAt: Date.now() },
  };
}

function planForageOf(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
  type: 'bush' | 'tree',
): ActionPlan | null {
  const candidates = resources.filter((r) => {
    if (r.type !== type) return false;
    if (type === 'bush') return Number(r.state?.berries ?? 0) > 0;
    return Number(r.state?.fruits ?? 0) > 0;
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

  const finalType: Action['type'] = type === 'bush' ? 'pickup_berry' : 'shake_tree';
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
    finalAction: { type: 'cook_meat', target: best.fire.id, startedAt: Date.now() },
  };
}

function planHunt(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
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

function planPickupWood(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
): ActionPlan | null {
  if (character.inventory.includes('wood')) return null;
  const woods = resources.filter((r) => r.type === 'wood');
  let best: { path: Position[]; wood: Resource } | null = null;
  for (const w of woods) {
    // Walk to the wood tile itself (walkable) — stand right over it for pickup.
    const path = findPath(character.position, [{ x: w.x, y: w.y }], blocked);
    if (path === null) continue;
    if (!best || path.length < best.path.length) best = { path, wood: w };
  }
  if (!best) return null;
  const smoothed = smoothPath(character.position, best.path, blocked);
  const jx = (Math.random() - 0.5) * 0.5;
  const jy = (Math.random() - 0.5) * 0.5;
  const floatPath = smoothed.length === 0
    ? smoothed
    : [...smoothed.slice(0, -1), { x: best.wood.x + jx, y: best.wood.y + jy }];
  return {
    path: floatPath,
    finalAction: { type: 'pickup_wood', target: best.wood.id, startedAt: Date.now() },
  };
}

function planForage(
  character: Character,
  resources: Resource[],
  blocked: Set<string>,
  wantedTypes: Array<'bush' | 'tree' | 'river'>,
): ActionPlan | null {
  const candidates = resources.filter((r) => {
    if (!wantedTypes.includes(r.type as 'bush' | 'tree' | 'river')) return false;
    if (r.type === 'bush' && Number(r.state?.berries ?? 0) <= 0) return false;
    if (r.type === 'tree' && Number(r.state?.fruits ?? 0) <= 0) return false;
    return true;
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

  const finalType: Action['type'] = best.target.type === 'bush'
    ? 'eat_berry'
    : best.target.type === 'tree'
      ? 'eat_fruit'
      : 'drink';
  const smoothed = smoothPath(character.position, best.path, blocked);
  return {
    path: applyOrganicStop(smoothed, best.target, character.position, blocked),
    finalAction: { type: finalType, target: best.target.id, startedAt: Date.now() },
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
    const ann = annotateWanderTarget(lastWalkable, knownResources, widthTiles, heightTiles, hints);
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

  return opts;
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
): { text: string; unexplored: boolean } {
  // Composition + staleness — count remembered resources by type within
  // WANDER_NEAR_RADIUS of the target tile, take the freshest lastSeenT among
  // them as the "age" annotation. The LLM uses this to decide whether to trust
  // its memory ("seen 1h ago" vs "seen 12h ago — might've regrown/depleted").
  const byType: Record<string, number> = {};
  let mostRecentLastSeen = -Infinity;
  for (const r of known) {
    const d = Math.hypot(r.x - tgt.x, r.y - tgt.y);
    if (d > WANDER_NEAR_RADIUS) continue;
    byType[r.type] = (byType[r.type] ?? 0) + 1;
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
): Promise<DecideResult | null> {
  const options = enumerateWanderOptions(character, blocked, knownResources, hints);
  // Engine couldn't enumerate any directional options (extremely tight space)
  // — drop back to the legacy random wander so the character still moves.
  if (options.length <= 1) {
    const w = wander(character, blocked);
    return w ? { plan: w } : null;
  }
  const summary = summarizeRemembered(knownResources);
  const result = await picker.pickWander({ character, options, rememberedSummary: summary });
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

function summarizeRemembered(known: Resource[]): string {
  if (known.length === 0) return 'nothing (blank memory)';
  const byType: Record<string, number> = {};
  for (const r of known) byType[r.type] = (byType[r.type] ?? 0) + 1;
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
