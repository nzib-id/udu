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
  hungerTrigger: 25,                // start seeking food when hunger <= 25
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
  rangeNight: 5,
  fovDegrees: 120,
  scanEveryTicks: 2,                // scan vision every N ticks (perf — 2 ticks = 1s)
  nightStart: 21,
  nightEnd: 5,
} as const;

export const NUTRITION = {
  hungerPerBerry: 2,                // segenggam buah liar
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
  dropEveryGameHours: 12,
} as const;

export const ANIMAL_CONFIG = {
  chickenCount: 2,                  // scarce: hunting jadi event langka
  chickenSpeedTilesPerSec: 1.5,     // wander pace
  chickenFleeSpeedTilesPerSec: 3.5, // faster when running away
  chickenFleeRange: 4,              // if char within 4 tiles → flee
  chickenFleeDistance: 8,           // flee this many tiles from char
  chickenWanderRange: 15,           // pick wander target anywhere within this range (whole map feel)
  chickenRespawnGameHours: 24,      // scarce: 1 game-day respawn
  fishCount: 2,                     // scarce
  fishRespawnGameHours: 24,
} as const;

export const FIRE_CONFIG = {
  // Fixed fire pit position (near map center, slightly offset to not block spawn).
  x: Math.floor(MAP_CONFIG.widthTiles / 2) + 4,
  y: Math.floor(MAP_CONFIG.heightTiles / 2),
  cookDurationTicks: 10,            // 10 ticks × 500ms = 5 real-sec = 5 game-min
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
//   hunger=0       -15
//   thirst=0       -20
//   energy=0       -10
//   sickness>=80   -10
// Regen (HP/game-hour) ONLY when all comfort conditions hold simultaneously.
// Multiple drains stack — neglecting two drives at once kills faster.
export const HEALTH_CONFIG = {
  max: 100,
  initial: 100,
  drainPerGameHour: {
    hunger0: 15,
    thirst0: 20,
    energy0: 10,
    sickness80: 10,
  },
  regen: {
    perGameHour: 1,
    needsFloor: 60,         // hunger/thirst/energy must be >= this
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
  bushBerriesMax: 3,                // scarce: max 3 berry/bush
  treeFruitEveryDays: 5,            // scarce: regen tiap 5 game-day
  treeFruitPerCycle: 1,
  treeFruitsMax: 2,                 // scarce
} as const;

export const RESOURCE_CONFIG = {
  seed: 3,                          // bumped: fresh map for Phase 4 first-contact test
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
  forest: { treeDensity: 0.40, bushDensity: 0.05, treeBarrenChance: 0.80, bushBarrenChance: 0.70 },
  grove:  { treeDensity: 0.15, bushDensity: 0.20, treeBarrenChance: 0.50, bushBarrenChance: 0.40 },
  open:   { treeDensity: 0.02, bushDensity: 0.04, treeBarrenChance: 0.40, bushBarrenChance: 0.30 },
} as const;

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
