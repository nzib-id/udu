import { generateTerrainGrid, tilesOfType } from './terrain.js';

export const MAP_CONFIG = {
  widthTiles: 40,
  heightTiles: 30,
  tileSize: 16,
  worldWidth: 40 * 16,
  worldHeight: 30 * 16,
  cameraZoom: 2,
} as const;

export const TIME_CONFIG = {
  realMsPerGameMinute: 1000,
  gameMinutesPerHour: 60,
  gameHoursPerDay: 24,
  tickMs: 500,
  startHour: 6,                     // sunrise — fresh start every server restart
} as const;

export const DECAY_RATES = {
  hungerPerGameHour: 0.1,           // strict real: ~40 game-day starvation (manusia ~30-70 hari tanpa makan)
  thirstPerGameHour: 1.4,           // strict real: ~3 game-day dehydration (manusia 3-5 hari tanpa air)
  bladderPerGameHour: 3,
  energyPerGameHourActive: 3,
  energyPerGameHourSleep: -20,
  energyPerGameHourRest: -5,
} as const;

// Per-tile movement cost. Stack-applied each tile of forward motion the character
// takes. Walking is the dominant active drain → keeps the world from feeling
// "free" to traverse. Numbers tuned so a heavy day of foraging (≈150 tiles
// walked) reads as ~−15 energy / ~−6 thirst / ~−7.5 hunger above hourly decay.
export const TILE_DECAY = {
  energyPerTile: 0.10,
  thirstPerTile: 0.04,
  hungerPerTile: 0.05,
} as const;

// Per-action cost. Applied at the moment the action's executeFinal runs (i.e.
// when the verb actually happens, not when planning starts). Hunt also costs
// thirst because it's exertive. Sleep / drink / eat omitted — those are net
// recovery actions and balance comes from NUTRITION below.
export const ACTION_COSTS = {
  shakeTreeEnergy: 2,               // physical effort
  huntEnergy: 3,
  huntThirst: 3,                    // sweat
  pickupEnergy: 0.3,                // berry/fruit/wood — bend down
  cookMeatEnergy: 0.5,              // tend the fire
  defecateEnergy: 0.2,              // squat cost
} as const;

// Hysteresis on AI need-triggering. Old `urgencyThreshold` (single global
// value) made the character compulsively eat/drink whenever stats dipped.
// Now each need has its own trigger (high enough urgency to start) — natural
// stat regen during the action handles the "stop" side without explicit state.
export const THRESHOLDS = {
  hungerTrigger: 35,                // start seeking food when hunger <= 35
  thirstTrigger: 25,                // start seeking water when thirst <= 25
  energyTrigger: 15,                // start sleeping when energy <= 15
  bladderTrigger: 85,               // defecate when bladder >= 85
} as const;

// Rest behaviour — survival is the dominant goal, so sit is a rare flavour
// event ("oh dia duduk sebentar"), not a system. Three layers keep it scarce:
// (1) energy gate stops anyone with energy >= energyGate from even rolling,
// (2) low ceiling so even an exhausted character rolls only ~5%, (3) short
// window so the rest finishes quickly. game-loop also breaks rest the moment
// any need crosses its trigger threshold.
export const REST_CONFIG = {
  maxProbability: 0.05,             // ceiling at energy=0; scaled down by current energy
  minDurationMs: 15_000,            // 15 real-sec
  maxDurationMs: 30_000,            // 30 real-sec
  decayMultiplier: 0.3,             // tile/hourly decay scaled while resting
  energyGate: 60,                   // never rest while energy >= this
} as const;

export const NETWORK_CONFIG = {
  backendPort: 4247,
  wsPath: '/ws',
  stateBroadcastMs: 500,
  reconnectBackoffMs: [1000, 2000, 4000, 8000, 16000, 30000],
} as const;

export const CHARACTER_CONFIG = {
  spawnX: Math.floor(MAP_CONFIG.widthTiles / 2),
  spawnY: Math.floor(MAP_CONFIG.heightTiles / 2),
  persistEveryTicks: 20,
} as const;

export const AI_CONFIG = {
  speedTilesPerSec: 2.5,            // character base walking speed (continuous, tiles per real second)
  arriveEpsilon: 0.05,              // distance to waypoint before popping it
  stopOffsetTiles: 0.8,             // organic stop distance from resource center
  decideEveryTicks: 2,
  wanderRadius: 8,
  sleepWakeEnergy: 90,              // sleep until energy >= this (deep recovery)
} as const;

// Spatial perception. Character "sees" tiles inside a forward cone of vision
// — type + location of resources land in spatial memory passively. Property
// knowledge ("shake_tree drops fruit", "berry edible") is NOT captured here;
// that emerges from the observation log + reflection LLM.
//   rangeDay      — radius (tiles) the cone extends to during day phases.
//   rangeNight    — radius during night (hour >= nightStart || hour < nightEnd).
//   fovDegrees    — width of the forward cone (binocular human FoV ≈ 120°).
//   nightStart/End define the "dark" window matching circadian.
// Line of sight is checked per tile via existing pathfinder.hasLineOfSight,
// so trees/bushes/rivers occlude tiles directly behind them.
export const VISION_CONFIG = {
  rangeDay: 15,
  rangeNight: 3,                    // raw dark — almost blind, see only immediate surroundings
  rangeNightNearFire: 8,            // boost when within FIRE_CONFIG.warmthRadius of any lit fire
  fovDegrees: 120,
  scanEveryTicks: 2,                // scan vision every N ticks (perf — 2 ticks = 1s)
  nightStart: 21,
  nightEnd: 5,
} as const;

export const NUTRITION = {
  hungerPerBerry: 5,                // segenggam buah liar
  hungerPerFruit: 5,                // 1 buah besar
  thirstPerDrink: 25,               // ~1 cup air, cover hampir 1 game-day thirst
  hungerPerMeatRaw: 8,              // ayam kecil mentah
  hungerPerMeatCooked: 15,          // matang ~2x lebih kenyang
  sicknessPerMeatRaw: 20,
  // Eating/drinking also restores a little energy — calories → metabolism.
  // Sleep is still the dominant recovery (+10/h), food is the tiny boost.
  energyPerBerry: 1,
  energyPerFruit: 2,
  energyPerMeatRaw: 4,              // half cooked since digestion is taxed
  energyPerMeatCooked: 8,
  energyPerDrink: 0.5,
} as const;

export const WOOD_CONFIG = {
  dropEveryGameHours: 48,           // per-tree cooldown — ~23 wood/game-day vs 24 burn = forced foraging
} as const;

// Inventory weight cap. No "slot count" — total carried weight ≤ MAX, AI
// decides what to drop/skip when over. Numbers tuned so a pure-fuel run (5
// wood) and a pure-meat run (5 raw) both max out at exactly 10.
//   wood          2.0   log of timber, heaviest
//   meat_raw      2.0   carcass before processing
//   meat_cooked   1.5   lighter after cooking (water loss)
//   fruit         1.0   medium-size berry/fruit
//   berry         0.4   small handful, very light
// Combos in spec: hunting trip 3 wood + 2 raw = 10, forage 4 fruit + 10 berry = 8.
export const INVENTORY_WEIGHTS: Readonly<Record<string, number>> = {
  wood: 1.5,
  branch: 0.8,
  vine: 0.5,
  stone: 2.0,
  meat_raw: 2.0,
  meat_cooked: 1.5,
  fruit: 1.0,
  berry: 0.4,
};
export const MAX_INVENTORY_WEIGHT = 20;

export const ANIMAL_CONFIG = {
  chickenCount: 2,                  // scarce: hunting jadi event langka
  chickenSpeedTilesPerSec: 1.5,     // wander pace
  chickenFleeSpeedTilesPerSec: 3.5, // faster when running away
  chickenFleeRange: 4,              // if char within 4 tiles → flee
  chickenFleeDistance: 8,           // flee this many tiles from char
  chickenWanderRange: 15,           // pick wander target anywhere within this range (whole map feel)
  chickenRespawnGameHours: 24,      // scarce: 1 game-day respawn
  // Hunger stat — caps fruit consumption so chickens don't vacuum the map.
  // Decay 2/h → ~50 game-hours full→empty (~2 game-day starvation).
  // Chase gate at 50 + eat gain 30 → ~1 fruit per 15 real-min per chicken
  // (cycle: 50 → eat → 80 → decay → 50). 2 chickens × 24min day = ~3 fruit/day.
  chickenHungerMax: 100,
  chickenHungerStart: 60,
  chickenHungerDecayPerGameHour: 2,
  chickenHungerPerFruit: 30,
  chickenHungerChaseThreshold: 50,  // only chase fruit when hunger <= this
  fishCount: 2,                     // scarce
  fishRespawnGameHours: 24,
} as const;

export const FIRE_CONFIG = {
  // Fixed fire pit position (near map center, slightly offset to not block spawn).
  x: Math.floor(MAP_CONFIG.widthTiles / 2) + 4,
  y: Math.floor(MAP_CONFIG.heightTiles / 2),
  // Fuel mechanic — fire requires wood, runs out, can be unlit.
  initialFuel: 24,                  // free spawn — ~1 game-day buffer at 1/h burn
  maxFuel: 24,
  burnPerGameHour: 1,               // 1 wood / game-hour while lit
  warmthRadius: 3,                  // tiles — chars inside this AND fire is lit get warmth override
  refuelRadius: 1,                  // tiles — must be adjacent to add_fuel
} as const;

// Temperature stat — per-character body temperature. Drifts toward phase
// ambient at `driftPerGameMinute`. Fire radius (FIRE_CONFIG.warmthRadius)
// + lit overrides ambient to `fireWarmthAmbient`. Out-of-comfort body temp
// drains HP directly (see HEALTH_CONFIG.drainPerGameHour.tempCold*/tempHot*) —
// pure HP path so the AI sees a single clear signal: temp drift → HP drop.
// Sleep + fire-radius + lit = immunity (the single most load-bearing
// behaviour the AI must learn).
export const TEMPERATURE_CONFIG = {
  initial: 25,
  comfortMin: 20,
  comfortMax: 30,
  driftPerGameMinute: 0.3,          // °C/game-min toward target ambient
  // Phase ambients — picked off by current game-hour bracket.
  phaseAmbient: {
    morning: 22,                    // 5–11
    afternoon: 30,                  // 11–17
    evening: 24,                    // 17–21
    night: 16,                      // 21–5
  },
  fireWarmthAmbient: 28,            // override when char in fire radius AND fire is lit
  // Sleep modifier — body metabolism slows during sleep; fire fully immunizes.
  // Applied to temperature-driven HP drain only.
  sleepDrainMultiplier: 0.5,        // sleeping anywhere
  fireSleepImmunity: true,          // sleeping in fire radius AND fire lit → drain × 0
} as const;

// Sickness funnel — bladder pressure feeds sickness instead of direct HP.
// Char "feels sick first" before drives spiral. Recovery rule prevents
// permanent sickness state once exposed.
export const SICKNESS_FUNNEL = {
  bladderFullThreshold: 100,        // bladder == 100 → sickness +bladderFullDrainPerHour
  bladderFullDrainPerGameHour: 5,
  recoveryPerGameHour: 2,           // sickness -2/h when below recovery thresholds
  recoveryBladderCeil: 70,          // bladder must be < this for recovery
  // (recovery also requires "no raw meat in system" — gated by sickness source tracking)
} as const;

export const SICKNESS_CONFIG = {
  decayPerGameHour: 5,
  slowMoveThreshold: 30,            // sickness > 30 → slower movement
  slowMoveSpeedMultiplier: 0.5,     // speed × this when sick
} as const;

export const DEATH_CONFIG = {
  // graceGameHours retained for legacy reference; new HP funnel makes it the
  // *expected* time-to-death from a single drive at 0 (HP100 / 15HP/h ≈ 6.67h).
  graceGameHours: 6,
  respawnDelayMs: 3000,             // dramatic pause before new character spawns
  minRespawnDistanceTiles: 20,      // new spawn must be at least this far from death site
} as const;

// HP — central death funnel.
// Drain (HP/game-hour) when source condition holds:
//   hunger=0          -15
//   thirst=0          -20
//   energy=0          -10
//   sickness>=80      -10
//   body temp <20°C    -5  (cool drift, e.g. night without fire)
//   body temp <10°C   -15  (severe cold)
//   body temp >30°C    -5  (mild hot)
//   body temp >40°C   -15  (severe hot)
// Temperature drain is multiplied by sleep modifier (×0.5) and zeroed by
// sleeping inside a lit fire's warmth radius (full immunity). The cold/hot
// severity tiers do NOT stack — the harsher tier replaces the milder one.
// Regen (HP/game-hour) ONLY when all comfort conditions hold simultaneously.
// Multiple drains across drives + temp stack — neglecting two at once kills faster.
export const HEALTH_CONFIG = {
  max: 100,
  initial: 100,
  drainPerGameHour: {
    hunger0: 15,
    thirst0: 20,
    energy0: 10,
    sickness80: 10,
    tempColdMild: 5,    // body < 20°C
    tempColdSevere: 15, // body < 10°C (replaces tempColdMild, doesn't stack)
    tempHotMild: 5,     // body > 30°C
    tempHotSevere: 15,  // body > 40°C (replaces tempHotMild, doesn't stack)
  },
  regen: {
    perGameHour: 1,
    needsFloor: 50,         // hunger/thirst/energy must be >= this
    bladderCeil: 40,        // bladder must be <= this
    sicknessCeil: 30,       // sickness must be < this
  },
  sicknessDrainThreshold: 80,
} as const;

export const CAMERA_CONFIG = {
  minZoom: 0.75,
  maxZoom: 5,
  zoomStep: 0.2,                    // per wheel tick
  panSpeedPxPerSec: 400,            // keyboard pan speed (screen px)
  followRecenterSmoothing: 0.15,    // lerp factor when following character
} as const;

export const REGEN_CONFIG = {
  bushBerryPerDay: 1,
  bushBerriesMax: 4,                // scarce but workable
  treeFruitEveryDays: 2,            // 2 game-day per fruit (locked 2026-04-27)
  treeFruitPerCycle: 1,
  treeFruitsMax: 2,                 // scarce
  // Phase A.1 — tree_wood (branch supply for fire fuel). Tighter than fruit:
  // 13 productive tree_wood × 1 branch/day ≈ 12-13 branches/day map-wide,
  // matches ~12h fire-on-per-day burn (12 fuel/day at burnPerGameHour=1).
  treeWoodRefillGameHours: 24,      // 1 branch / game-day per tree_wood
  treeWoodBranchesMax: 2,
  // tree_vine — placeholder cadence (Phase B crafting consumer pending).
  treeVineEveryDays: 5,
  treeVinesMax: 2,
  // Auto-drop: how often a tree releases one product from its stash to the
  // ground tile next to it. Rare by design — shake is the primary harvest;
  // auto-drop just prevents stash from sitting forever (locked 2026-04-27).
  treeAutoDropGameHours: 48,
} as const;

// Per-tree-type spawn ratio when seeding. Sum should be 1.0.
export const TREE_TYPE_RATIO = {
  fruit: 0.5,
  vine: 0.25,
  wood: 0.25,
} as const;

export const RESOURCE_CONFIG = {
  seed: 4,                          // bumped: fresh map for Batch 7 + Cara A observation run
  bushBerriesMin: 1,
  bushBerriesMax: 3,
  treeFruitsMin: 1,
  treeFruitsMax: 2,
} as const;

// Per-biome resource generation. Density = chance per grass tile that a
// tree/bush spawns there. Barren chance = of those that spawn, fraction that
// produces no food (visible scenery only). Forest is rimbun but mostly barren;
// grove is the food-rich zone; open is sparse but more often productive.
export const BIOME_CONFIG = {
  forest: { treeDensity: 0.40, bushDensity: 0.05, treeBarrenChance: 0.80, bushBarrenChance: 0.70, boulderDensity: 0.04 },
  grove:  { treeDensity: 0.15, bushDensity: 0.20, treeBarrenChance: 0.50, bushBarrenChance: 0.40, boulderDensity: 0.02 },
  open:   { treeDensity: 0.02, bushDensity: 0.04, treeBarrenChance: 0.40, bushBarrenChance: 0.30, boulderDensity: 0.01 },
} as const;

// Boulder mining: each boulder yields N stones before despawning.
export const BOULDER_CONFIG = {
  stonesPerBoulder: 5,
  initialGroundStones: 8, // scattered free stones on world gen
} as const;

// Phase 2 physics — items have continuous (x,y) + altitude z + velocity. Items
// at rest skip the tick handler; only in-flight items (vel above threshold OR
// z>0) consume cycles. Units: tiles per game-loop tick. Tick rate = 500ms.
export const PHYSICS_CONFIG = {
  gravity: 1.0,           // -z accel per tick (z=1 lands ~2 ticks ≈ 1 sec)
  airFriction: 0.85,      // vx, vy multiplier per tick (decay so items settle)
  settleThreshold: 0.05,  // |v| below this and z<=0 → settled, drop from queue
  pickupRadius: 0.75,     // proximity gate for pickup (≈12px at tilesize 16)
} as const;

// Initial physics state for natural drops. Manual drop = item plops at char
// pos with all zeros (item can overlap; no auto-offset). Tree shake / hunt /
// future throw use these velocities to "throw" the item via gravity sim.
export const DROP_INIT = {
  treeShake: () => ({
    z: 1.0,                                  // start at canopy height
    vx: (Math.random() - 0.5) * 0.4,         // ±0.2 horizontal
    vy: 0.3 + Math.random() * 0.3,           // 0.3..0.6 +y (south, toward viewer)
    vz: 0,
  }),
  treeAutoDrop: () => ({
    z: 1.0,
    vx: (Math.random() - 0.5) * 0.4,
    vy: 0.3 + Math.random() * 0.3,
    vz: 0,
  }),
  hunt: { z: 0, vx: 0, vy: 0, vz: 0 },
  manual: { z: 0, vx: 0, vy: 0, vz: 0 },
} as const;

// Phase 3 glossary truth table — hidden ground-truth map of ResourceType →
// tag set. Char glossary stays empty until observe reveals each entry. NEVER
// expose this map to the LLM directly; it's the answer key the observe
// mechanic decodes via "eat-and-see" outcomes (or instant inedible reveal).
//   edible: nutrition gain, no sickness on consume.
//   poisonous: edible but consume triggers sickness (e.g. raw meat).
//   drinkable: consumable via drink (rivers).
//   inedible: anything observable but non-consumable — animals alive, trees,
//     stones, fire, etc. Char learns "this isn't food" by observing.
// Animals are inedible (can't eat live); their meat is the consumable. Trees
// are inedible (can't eat the tree); their fruit/vine/branch are.
import type { Glossary, GlossaryTag } from './types.js';

// Phase 3 — parent category mapping. Subtypes that share an identifiable parent
// shape (tree/animal) display as the parent name in LLM prompts until the
// specific subtype is observed. Acts as the "I can tell it's a tree but not
// what kind" layer.
export const RESOURCE_PARENT: Record<string, string> = {
  tree_fruit: 'tree',
  tree_wood: 'tree',
  tree_vine: 'tree',
  animal_chicken: 'animal',
  animal_fish: 'animal',
};

// Parents auto-known to gen 0. Subtypes inside still need observation to lock
// down specific identity; the parent label just bridges "unknown" → "tree".
export const BASIC_KNOWN_PARENTS = new Set(['tree', 'animal']);

// Types fully auto-known to gen 0 (full tag reveal, no mask). Seeded into the
// glossary on first spawn and persisted so subsequent loads + lineage
// inheritance carry them forward. Limited to permanent terrain features
// (river, fire) — char wakes up knowing what these obvious elements are.
export const BASIC_KNOWN_TYPES: Record<string, GlossaryTag[]> = {
  river: ['drinkable'],
  fire: ['inedible'],
};

// Mask a ResourceType for LLM display based on character glossary.
// - In glossary → real type name (full reveal).
// - Has basic-known parent → parent label (e.g. tree_fruit → 'tree').
// - Otherwise → 'unknown_thing'.
export function maskType(type: string, glossary: Glossary): string {
  if (glossary[type]) return type;
  const parent = RESOURCE_PARENT[type];
  if (parent && BASIC_KNOWN_PARENTS.has(parent)) return parent;
  return 'unknown_thing';
}

// Mask a target string of form `<type><_digits>+`. Strips ALL trailing
// `_<digits>` groups so multi-segment id suffixes (`river_38_12`, `bush_15`,
// `tree_fruit_3`) reduce to their type prefix; maskType handles the prefix and
// the numeric tail is reattached untouched. Falls back to maskType for non-id
// strings (bare type names like `berry`, `meat_raw`). Used for option targets
// and observation log entries so type names never leak before observe.
export function maskTarget(target: string, glossary: Glossary): string {
  const m = target.match(/^(.+?)((?:_\d+)+)$/);
  if (m) {
    return `${maskType(m[1], glossary)}${m[2]}`;
  }
  return maskType(target, glossary);
}

export const RESOURCE_TRUTH: Record<string, GlossaryTag[]> = {
  // Consumables.
  fruit: ['edible'],
  berry: ['edible'],
  meat_raw: ['edible', 'poisonous'],
  meat_cooked: ['edible'],
  // Drinkables.
  river: ['drinkable'],
  // Static sources.
  bush: ['inedible'],
  tree_fruit: ['inedible'],
  tree_vine: ['inedible'],
  tree_wood: ['inedible'],
  fire: ['inedible'],
  boulder: ['inedible'],
  // Animals (alive — must hunt to get meat).
  animal_chicken: ['inedible'],
  animal_fish: ['inedible'],
  // Inedible items.
  wood: ['inedible'],
  branch: ['inedible'],
  vine: ['inedible'],
  stone: ['inedible'],
};

// Terrain grid is generated once at module load from the shared seed. Both
// frontend (rendering) and backend (water/fish spawn) consume this grid so map
// layout stays identical across the stack.
const TERRAIN_SAFE_ZONES = [
  // Player spawn — keep center clear grass.
  { x: CHARACTER_CONFIG.spawnX, y: CHARACTER_CONFIG.spawnY, radius: 3 },
  // Fire pit — fixed world position.
  { x: FIRE_CONFIG.x, y: FIRE_CONFIG.y, radius: 2 },
];

export const TERRAIN_GRID = generateTerrainGrid(
  RESOURCE_CONFIG.seed,
  MAP_CONFIG.widthTiles,
  MAP_CONFIG.heightTiles,
  TERRAIN_SAFE_ZONES,
);

export const WATER_TILES = tilesOfType(TERRAIN_GRID, 'water');
export const DIRT_TILES = tilesOfType(TERRAIN_GRID, 'dirt');
