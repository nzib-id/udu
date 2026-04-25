import type Database from 'better-sqlite3';
import type { Resource } from '../../shared/types.js';
import {
  ANIMAL_CONFIG,
  BIOME_CONFIG,
  DIRT_TILES,
  FIRE_CONFIG,
  MAP_CONFIG,
  RESOURCE_CONFIG,
  TERRAIN_GRID,
  WATER_TILES,
} from '../../shared/config.js';

type ResourceRow = {
  id: string;
  type: string;
  x: number;
  y: number;
  state: string;
};

export class ResourceRepo {
  constructor(private db: Database.Database) {}

  loadAll(): Resource[] {
    const rows = this.db.prepare('SELECT * FROM resource_state').all() as ResourceRow[];
    return rows.map(rowToResource);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM resource_state').get() as { n: number };
    return row.n;
  }

  persist(r: Resource): void {
    this.db
      .prepare(
        `INSERT INTO resource_state (id, type, x, y, state) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type, x = excluded.x, y = excluded.y, state = excluded.state`,
      )
      .run(r.id, r.type, r.x, r.y, JSON.stringify(r.state));
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM resource_state WHERE id = ?').run(id);
  }

  seedIfEmpty(): Resource[] {
    if (this.count() > 0) {
      const existing = this.loadAll();
      const backfilled = this.backfillPhase3(existing);
      return backfilled.length > 0 ? [...existing, ...backfilled] : existing;
    }
    const resources = generateInitialResources();
    const tx = this.db.transaction((list: Resource[]) => {
      for (const r of list) this.persist(r);
    });
    tx(resources);
    console.log(`[resource-repo] seeded ${resources.length} resources`);
    return resources;
  }

  /**
   * Add fire + animals if the DB was seeded pre-Phase 3 and is missing them.
   * Safe to re-run; only persists what's absent.
   */
  private backfillPhase3(existing: Resource[]): Resource[] {
    const hasFire = existing.some((r) => r.type === 'fire');
    const chickenCount = existing.filter((r) => r.type === 'animal_chicken').length;
    const fishCount = existing.filter((r) => r.type === 'animal_fish').length;
    const added: Resource[] = [];
    const occupied = new Set(existing.map((r) => `${r.x},${r.y}`));

    if (!hasFire) {
      let fx = FIRE_CONFIG.x;
      let fy = FIRE_CONFIG.y;
      while (occupied.has(`${fx},${fy}`) && fy < MAP_CONFIG.heightTiles - 1) fy++;
      const fire: Resource = { id: 'fire_main', type: 'fire', x: fx, y: fy, state: { lit: true } };
      added.push(fire);
      occupied.add(`${fx},${fy}`);
    }

    const blocked = new Set(
      existing.filter((r) => r.type === 'bush' || r.type === 'tree' || r.type === 'river').map((r) => `${r.x},${r.y}`),
    );
    for (let i = chickenCount; i < ANIMAL_CONFIG.chickenCount; i++) {
      for (let attempt = 0; attempt < 200; attempt++) {
        const x = Math.floor(Math.random() * MAP_CONFIG.widthTiles);
        const y = Math.floor(Math.random() * MAP_CONFIG.heightTiles);
        const key = `${x},${y}`;
        if (occupied.has(key) || blocked.has(key)) continue;
        const id = `chicken_backfill_${i}_${Date.now() % 1000000}`;
        added.push({ id, type: 'animal_chicken', x, y, state: {} });
        occupied.add(key);
        break;
      }
    }

    const river = existing.filter((r) => r.type === 'river');
    const fishPositions = new Set(
      existing.filter((r) => r.type === 'animal_fish').map((r) => `${r.x},${r.y}`),
    );
    for (let i = fishCount; i < ANIMAL_CONFIG.fishCount; i++) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const pick = river[Math.floor(Math.random() * river.length)];
        if (!pick) break;
        const key = `${pick.x},${pick.y}`;
        if (fishPositions.has(key)) continue;
        const id = `fish_backfill_${pick.x}_${pick.y}`;
        added.push({ id, type: 'animal_fish', x: pick.x, y: pick.y, state: {} });
        fishPositions.add(key);
        break;
      }
    }

    if (added.length === 0) return [];
    const tx = this.db.transaction((list: Resource[]) => {
      for (const r of list) this.persist(r);
    });
    tx(added);
    console.log(`[resource-repo] backfilled phase 3 resources: ${added.length}`);
    return added;
  }
}

function rowToResource(row: ResourceRow): Resource {
  let state: Record<string, unknown> = {};
  try {
    const v = JSON.parse(row.state);
    if (v && typeof v === 'object') state = v as Record<string, unknown>;
  } catch { /* ignore */ }
  return { id: row.id, type: row.type as Resource['type'], x: row.x, y: row.y, state };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateInitialResources(): Resource[] {
  const rand = mulberry32(RESOURCE_CONFIG.seed);
  const used = new Set<string>();
  const result: Resource[] = [];

  // Water tiles — sourced from the shared terrain grid so renderer and
  // gameplay agree on which cells are drinkable.
  for (const { x, y } of WATER_TILES) {
    const key = `${x},${y}`;
    if (used.has(key)) continue;
    used.add(key);
    result.push({ id: `river_${x}_${y}`, type: 'river', x, y, state: {} });
  }

  const spawnTile = `${Math.floor(MAP_CONFIG.widthTiles / 2)},${Math.floor(MAP_CONFIG.heightTiles / 2)}`;
  used.add(spawnTile);

  const dirtBlocked = new Set(DIRT_TILES.map(({ x, y }) => `${x},${y}`));

  // Iterate every grass tile, roll density per its biome. Forest gets dense
  // tree cover (rimbun) but mostly barren; grove is the food zone; open is
  // sparse but more often productive. Bush/tree never on dirt or water.
  let treeIdx = 0;
  let bushIdx = 0;

  for (let y = 0; y < MAP_CONFIG.heightTiles; y++) {
    for (let x = 0; x < MAP_CONFIG.widthTiles; x++) {
      const key = `${x},${y}`;
      if (used.has(key)) continue;
      if (dirtBlocked.has(key)) continue;
      if (TERRAIN_GRID.cells[y][x] !== 'grass') continue;

      const biome = TERRAIN_GRID.biomes[y][x];
      const cfg = BIOME_CONFIG[biome];

      // Tree roll first — denser trees are the defining feature of forest.
      if (rand() < cfg.treeDensity) {
        // Forest allows adjacency (rimbun); other biomes need a buffer for
        // pathing breathing room.
        if (biome === 'forest' || hasFreeNeighbors(key, used)) {
          const barren = rand() < cfg.treeBarrenChance;
          const state = barren
            ? { fruits: 0, barren: true }
            : {
                fruits: Math.floor(
                  RESOURCE_CONFIG.treeFruitsMin +
                    rand() * (RESOURCE_CONFIG.treeFruitsMax - RESOURCE_CONFIG.treeFruitsMin + 1),
                ),
              };
          used.add(key);
          result.push({ id: `tree_${treeIdx++}`, type: 'tree', x, y, state });
          continue;
        }
      }

      // Bush roll — bushes always need a free buffer (pickable from any side).
      if (rand() < cfg.bushDensity) {
        if (!hasFreeNeighbors(key, used)) continue;
        const barren = rand() < cfg.bushBarrenChance;
        const state = barren
          ? { berries: 0, barren: true }
          : {
              berries: Math.floor(
                RESOURCE_CONFIG.bushBerriesMin +
                  rand() * (RESOURCE_CONFIG.bushBerriesMax - RESOURCE_CONFIG.bushBerriesMin + 1),
              ),
            };
        used.add(key);
        result.push({ id: `bush_${bushIdx++}`, type: 'bush', x, y, state });
      }
    }
  }

  // Fire pit — single fixed location. If that tile is occupied, slide down
  // until we find free grass.
  {
    let fx = FIRE_CONFIG.x;
    let fy = FIRE_CONFIG.y;
    while (used.has(`${fx},${fy}`) && fy < MAP_CONFIG.heightTiles - 1) fy++;
    used.add(`${fx},${fy}`);
    result.push({ id: 'fire_main', type: 'fire', x: fx, y: fy, state: { lit: true } });
  }

  // Chickens — wander over land. Allow adjacency to bush/tree so they can hide near cover.
  {
    let placed = 0;
    let attempts = 0;
    while (placed < ANIMAL_CONFIG.chickenCount && attempts < ANIMAL_CONFIG.chickenCount * 50) {
      attempts++;
      const x = Math.floor(rand() * MAP_CONFIG.widthTiles);
      const y = Math.floor(rand() * MAP_CONFIG.heightTiles);
      const key = `${x},${y}`;
      if (used.has(key)) continue;
      if (TERRAIN_GRID.cells[y][x] !== 'grass') continue;
      used.add(key);
      result.push({ id: `chicken_${placed}`, type: 'animal_chicken', x, y, state: { lastMoveTick: 0 } });
      placed++;
    }
  }

  // Fish — spread across available water tiles.
  {
    if (WATER_TILES.length > 0) {
      const stride = Math.max(1, Math.floor(WATER_TILES.length / (ANIMAL_CONFIG.fishCount + 1)));
      let placed = 0;
      for (let i = stride; placed < ANIMAL_CONFIG.fishCount && i < WATER_TILES.length; i += stride) {
        const { x, y } = WATER_TILES[i];
        result.push({ id: `fish_${x}_${y}`, type: 'animal_fish', x, y, state: {} });
        placed++;
      }
    }
  }

  return result;
}

function hasFreeNeighbors(key: string, used: Set<string>): boolean {
  const [sx, sy] = key.split(',').map(Number);
  // Keep a one-tile buffer so bushes/trees aren't directly adjacent — path planning later is cleaner.
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (used.has(`${sx + dx},${sy + dy}`)) return false;
    }
  }
  return true;
}
