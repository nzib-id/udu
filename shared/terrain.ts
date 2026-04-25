// Deterministic terrain grid + biome generator — single source of truth shared
// by frontend (rendering) and backend (resource spawning).

export type TerrainType = 'grass' | 'water' | 'dirt';
export type BiomeType = 'forest' | 'grove' | 'open';

export interface TerrainGrid {
  width: number;
  height: number;
  cells: TerrainType[][]; // indexed [y][x]
  biomes: BiomeType[][];  // gameplay-only, parallel to cells
}

export interface SafeZone {
  x: number;
  y: number;
  radius: number;
}

const DIRT_PCT = 0.10;
const DIRT_SEED_COUNT = 10;
const WATER_DIRT_BUFFER = 1; // cells of grass required between water and dirt

const FOREST_ZONE_COUNT = 3;
const FOREST_ZONE_SIZE = 130;
const GROVE_ZONE_COUNT = 5;
const GROVE_ZONE_SIZE = 70;

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

function inSafeZone(x: number, y: number, zones: SafeZone[]): boolean {
  for (const z of zones) {
    if (Math.abs(x - z.x) <= z.radius && Math.abs(y - z.y) <= z.radius) return true;
  }
  return false;
}

function hasNeighborOfType(
  cells: TerrainType[][],
  x: number,
  y: number,
  type: TerrainType,
  range: number,
): boolean {
  const height = cells.length;
  const width = cells[0].length;
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (cells[ny][nx] === type) return true;
    }
  }
  return false;
}

function growPatches(
  cells: TerrainType[][],
  rng: () => number,
  type: Exclude<TerrainType, 'grass'>,
  seedCount: number,
  totalTargetCount: number,
  safeZones: SafeZone[],
  extraConstraint: (x: number, y: number) => boolean,
): void {
  const height = cells.length;
  const width = cells[0].length;
  const sizePerSeed = Math.max(8, Math.floor(totalTargetCount / seedCount));
  const offsets: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const canPlace = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (cells[y][x] !== 'grass') return false;
    if (inSafeZone(x, y, safeZones)) return false;
    return extraConstraint(x, y);
  };

  let placedTotal = 0;
  for (let s = 0; s < seedCount && placedTotal < totalTargetCount; s++) {
    let sx = 0;
    let sy = 0;
    let found = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      sx = Math.floor(rng() * width);
      sy = Math.floor(rng() * height);
      if (canPlace(sx, sy)) {
        found = true;
        break;
      }
    }
    if (!found) continue;

    const placed: Array<{ x: number; y: number }> = [];
    cells[sy][sx] = type;
    placed.push({ x: sx, y: sy });
    placedTotal++;

    let stuck = 0;
    const stuckLimit = sizePerSeed * 6;
    while (
      placed.length < sizePerSeed &&
      placedTotal < totalTargetCount &&
      stuck < stuckLimit
    ) {
      const from = placed[Math.floor(rng() * placed.length)];
      const [dx, dy] = offsets[Math.floor(rng() * offsets.length)];
      const nx = from.x + dx;
      const ny = from.y + dy;
      if (canPlace(nx, ny)) {
        cells[ny][nx] = type;
        placed.push({ x: nx, y: ny });
        placedTotal++;
        stuck = 0;
      } else {
        stuck++;
      }
    }
  }
}

// Linear river path: edge → 3 randomly-perturbed waypoints → opposite edge.
// Width 1-2 tiles, randomized per segment so the river feels organic instead
// of a constant-width canal.
function generateRiver(
  cells: TerrainType[][],
  rng: () => number,
  safeZones: SafeZone[],
): void {
  const height = cells.length;
  const width = cells[0].length;

  type Side = 'N' | 'S' | 'E' | 'W';
  const sides: Side[] = ['N', 'S', 'E', 'W'];
  const entrySide = sides[Math.floor(rng() * 4)];
  const oppositeSide: Record<Side, Side> = { N: 'S', S: 'N', E: 'W', W: 'E' };
  const exitSide = oppositeSide[entrySide];

  const pickEdge = (side: Side) => {
    if (side === 'N') return { x: Math.floor(rng() * width), y: 0 };
    if (side === 'S') return { x: Math.floor(rng() * width), y: height - 1 };
    if (side === 'E') return { x: width - 1, y: Math.floor(rng() * height) };
    return { x: 0, y: Math.floor(rng() * height) };
  };

  const start = pickEdge(entrySide);
  const end = pickEdge(exitSide);

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len; // unit normal (perpendicular)
  const ny = dx / len;
  const offsetMagMax = Math.min(width, height) * 0.25;

  const waypoints: Array<{ x: number; y: number }> = [start];
  for (let i = 1; i <= 3; i++) {
    const t = i / 4;
    const baseX = start.x + dx * t;
    const baseY = start.y + dy * t;
    const off = (rng() - 0.5) * 2 * offsetMagMax;
    waypoints.push({
      x: Math.max(1, Math.min(width - 2, Math.round(baseX + nx * off))),
      y: Math.max(1, Math.min(height - 2, Math.round(baseY + ny * off))),
    });
  }
  waypoints.push(end);

  for (let i = 0; i < waypoints.length - 1; i++) {
    const thickness = 1 + (rng() < 0.5 ? 0 : 1); // 1 or 2
    drawThickLine(cells, waypoints[i], waypoints[i + 1], thickness, safeZones);
  }
}

function drawThickLine(
  cells: TerrainType[][],
  a: { x: number; y: number },
  b: { x: number; y: number },
  thickness: number,
  safeZones: SafeZone[],
): void {
  const height = cells.length;
  const width = cells[0].length;
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;
  const dxA = Math.abs(x1 - x0);
  const dyA = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dxA - dyA;

  const paintBrush = (cx: number, cy: number) => {
    for (let oy = 0; oy < thickness; oy++) {
      for (let ox = 0; ox < thickness; ox++) {
        const px = cx + ox;
        const py = cy + oy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        if (inSafeZone(px, py, safeZones)) continue;
        cells[py][px] = 'water';
      }
    }
  };

  while (true) {
    paintBrush(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 > -dyA) {
      err -= dyA;
      x0 += sx;
    }
    if (e2 < dxA) {
      err += dxA;
      y0 += sy;
    }
  }
}

// Biome zones grow as blobs on grass tiles. Forest first (largest, rimbun),
// then grove (smaller, food zone). Remaining grass stays 'open'.
function growBiomeZones(
  cells: TerrainType[][],
  biomes: BiomeType[][],
  rng: () => number,
  type: Exclude<BiomeType, 'open'>,
  zoneCount: number,
  zoneSize: number,
  safeZones: SafeZone[],
): void {
  const height = cells.length;
  const width = cells[0].length;
  const offsets: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];

  const canPlace = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    if (cells[y][x] !== 'grass') return false;
    if (biomes[y][x] !== 'open') return false;
    if (inSafeZone(x, y, safeZones)) return false;
    return true;
  };

  for (let s = 0; s < zoneCount; s++) {
    let sx = 0;
    let sy = 0;
    let found = false;
    for (let attempt = 0; attempt < 500; attempt++) {
      sx = Math.floor(rng() * width);
      sy = Math.floor(rng() * height);
      if (canPlace(sx, sy)) {
        found = true;
        break;
      }
    }
    if (!found) continue;

    const placed: Array<{ x: number; y: number }> = [];
    biomes[sy][sx] = type;
    placed.push({ x: sx, y: sy });

    let stuck = 0;
    const stuckLimit = zoneSize * 6;
    while (placed.length < zoneSize && stuck < stuckLimit) {
      const from = placed[Math.floor(rng() * placed.length)];
      const [dx, dy] = offsets[Math.floor(rng() * offsets.length)];
      const nx = from.x + dx;
      const ny = from.y + dy;
      if (canPlace(nx, ny)) {
        biomes[ny][nx] = type;
        placed.push({ x: nx, y: ny });
        stuck = 0;
      } else {
        stuck++;
      }
    }
  }
}

export function generateTerrainGrid(
  seed: number,
  width: number,
  height: number,
  safeZones: SafeZone[] = [],
): TerrainGrid {
  const cells: TerrainType[][] = [];
  const biomes: BiomeType[][] = [];
  for (let y = 0; y < height; y++) {
    cells.push(new Array<TerrainType>(width).fill('grass'));
    biomes.push(new Array<BiomeType>(width).fill('open'));
  }

  const rng = mulberry32(seed);
  const total = width * height;

  // River first — linear path edge-to-edge.
  generateRiver(cells, rng, safeZones);

  // Dirt second — never within buffer of water.
  growPatches(
    cells,
    rng,
    'dirt',
    DIRT_SEED_COUNT,
    Math.floor(total * DIRT_PCT),
    safeZones,
    (x, y) => !hasNeighborOfType(cells, x, y, 'water', WATER_DIRT_BUFFER),
  );

  // Biome zones populate remaining grass tiles.
  growBiomeZones(cells, biomes, rng, 'forest', FOREST_ZONE_COUNT, FOREST_ZONE_SIZE, safeZones);
  growBiomeZones(cells, biomes, rng, 'grove', GROVE_ZONE_COUNT, GROVE_ZONE_SIZE, safeZones);

  return { width, height, cells, biomes };
}

export function tilesOfType(
  grid: TerrainGrid,
  type: TerrainType,
): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.cells[y][x] === type) result.push({ x, y });
    }
  }
  return result;
}

export function tilesInBiome(
  grid: TerrainGrid,
  biome: BiomeType,
): Array<{ x: number; y: number }> {
  const result: Array<{ x: number; y: number }> = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (grid.cells[y][x] === 'grass' && grid.biomes[y][x] === biome) {
        result.push({ x, y });
      }
    }
  }
  return result;
}
