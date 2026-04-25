import Phaser from 'phaser';
import { MAP_CONFIG, TERRAIN_GRID } from '../../../shared/config';
import type { TerrainType } from '../../../shared/terrain';

// tileset.png: 192×48 dual-grid autotileset, 12×3 frames @ 16×16.
// Cols 0..5 = water overlay on grass (full 16-mask coverage).
// Cols 6..11 = dirt overlay on grass (full 16-mask coverage; frames 18/20/30 are blank).
const TILESET_KEY = 'tileset';
const TILESET_PATH = '/sprites/tiles/tileset.png?v=2';

// misc.png: 64×16 sheet, 4 frames @ 16×16 — grass tuft variants. Scattered
// on grass cells as cosmetic ground decor (baked into the terrain RenderTexture).
const MISC_KEY = 'misc_decor';
const MISC_PATH = '/sprites/tiles/misc.png?v=2';
const MISC_FRAME_COUNT = 4;
const MISC_DENSITY = 0.12; // fraction of grass cells that get a decor sprite

const GRASS_BASE_FRAME = 0;

// Mask: bit3=TL, bit2=TR, bit1=BL, bit0=BR. 1 = quarter is the overlay terrain.
// Values derived from the shipped tileset via quarter-classifier. -1 = skip render.
const WATER_FRAMES: readonly number[] = [
  /* 0  */ -1,
  /* 1  */ 1,
  /* 2  */ 3,
  /* 3  */ 2,
  /* 4  */ 25,
  /* 5  */ 13,
  /* 6  */ 29,
  /* 7  */ 17,
  /* 8  */ 27,
  /* 9  */ 28,
  /* 10 */ 15,
  /* 11 */ 16,
  /* 12 */ 26,
  /* 13 */ 5,
  /* 14 */ 4,
  /* 15 */ 14,
];

const DIRT_FRAMES: readonly number[] = [
  /* 0  */ -1,
  /* 1  */ 10,
  /* 2  */ 11,
  /* 3  */ 32,
  /* 4  */ 22,
  /* 5  */ 21,
  /* 6  */ 34,
  /* 7  */ 33,
  /* 8  */ 23,
  /* 9  */ 35,
  /* 10 */ 19,
  /* 11 */ 31,
  /* 12 */ 8,
  /* 13 */ 9,
  /* 14 */ 7,
  /* 15 */ 6,
];

const DIRT_FALLBACK_COLOR = 0x6a4538;

export function preloadTerrainSprites(scene: Phaser.Scene): void {
  scene.load.spritesheet(TILESET_KEY, TILESET_PATH, { frameWidth: 16, frameHeight: 16 });
  scene.load.spritesheet(MISC_KEY, MISC_PATH, { frameWidth: 16, frameHeight: 16 });
}

export class TerrainLayer {
  private rt: Phaser.GameObjects.RenderTexture;

  constructor(scene: Phaser.Scene) {
    const { widthTiles, heightTiles, tileSize } = MAP_CONFIG;
    const cells = TERRAIN_GRID.cells;

    this.rt = scene.add.renderTexture(0, 0, widthTiles * tileSize, heightTiles * tileSize);
    this.rt.setOrigin(0, 0);
    this.rt.setDepth(0);

    if (!scene.textures.exists(TILESET_KEY)) {
      // Defensive: paint a flat colour so the scene has *something* while assets load.
      this.rt.fill(DIRT_FALLBACK_COLOR);
      return;
    }

    // Layer 0 — solid grass base everywhere.
    for (let y = 0; y < heightTiles; y++) {
      for (let x = 0; x < widthTiles; x++) {
        this.rt.drawFrame(TILESET_KEY, GRASS_BASE_FRAME, x * tileSize, y * tileSize);
      }
    }

    // Layers 1 & 2 — dual-grid overlays. Render grid is (widthTiles+1) × (heightTiles+1),
    // offset by −½ tile so each render cell samples 4 world corners.
    const half = tileSize / 2;
    const drawOverlay = (target: Exclude<TerrainType, 'grass'>, frames: readonly number[]) => {
      for (let dy = 0; dy <= heightTiles; dy++) {
        for (let dx = 0; dx <= widthTiles; dx++) {
          const tl = cellIs(cells, dx - 1, dy - 1, target) ? 1 : 0;
          const tr = cellIs(cells, dx, dy - 1, target) ? 1 : 0;
          const bl = cellIs(cells, dx - 1, dy, target) ? 1 : 0;
          const br = cellIs(cells, dx, dy, target) ? 1 : 0;
          const mask = (tl << 3) | (tr << 2) | (bl << 1) | br;
          const frame = frames[mask];
          if (frame < 0) continue;
          this.rt.drawFrame(TILESET_KEY, frame, dx * tileSize - half, dy * tileSize - half);
        }
      }
    };

    drawOverlay('dirt', DIRT_FRAMES);
    drawOverlay('water', WATER_FRAMES);

    // Scatter grass-tuft / flower decor over pure-grass cells. Deterministic so
    // the layout is stable across reloads.
    if (scene.textures.exists(MISC_KEY)) {
      const rand = mulberry32(0xd3c0a5 ^ (widthTiles * 73856093) ^ (heightTiles * 19349663));
      for (let y = 0; y < heightTiles; y++) {
        for (let x = 0; x < widthTiles; x++) {
          if (cells[y][x] !== 'grass') continue;
          if (rand() >= MISC_DENSITY) continue;
          const frame = Math.floor(rand() * MISC_FRAME_COUNT);
          this.rt.drawFrame(MISC_KEY, frame, x * tileSize, y * tileSize);
        }
      }
    }
  }
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

function cellIs(
  cells: TerrainType[][],
  x: number,
  y: number,
  target: TerrainType,
): boolean {
  const { widthTiles, heightTiles } = MAP_CONFIG;
  if (x < 0 || y < 0 || x >= widthTiles || y >= heightTiles) return false;
  return cells[y][x] === target;
}
