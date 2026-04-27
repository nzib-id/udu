import Phaser from 'phaser';
import type { Resource } from '../../../shared/types';

// Resource sprite atlases (frames within a single sheet):
//   tree_fruit.png / tree_vine.png / tree_wood.png  48×48 × 2 frames each — [0]=trunk, [1]=canopy
//   bushes.png  32×32 — loaded twice: as 16×16 × 4 frames and as 32×16 × 2 frames.
//                        Small (16×16): [2]=berry bush, [3]=empty dome.
//                        Big (32×16): frame 0 = big bush spanning 2 tiles.
//   fireplace.png      16×16 × 4 frames — animated fire (lit)
//   fireplace_off.png  16×16 single frame — cold/extinguished pit (no fuel)
//   chicken.png 16×16 × 6 frames  — top-row walk cycle (bottom row reserved; use flipX for direction)
//   items.png   16×16 × 8 frames (4 cols × 2 rows) — [0]=fruit, [1]=berry, [2]=wood log, [3]=vine, [4]=stone
//   boulder.png 32×32 single frame — mineable stone source (extends upward from tile)
// (Character sprites are owned by CharacterSprite.ts, not duplicated here.)
type SheetDef = {
  key: string;
  path: string;
  frameWidth: number;
  frameHeight: number;
  // Optional anim config — only defined sheets that should loop at runtime.
  animFrames?: number;
  fps?: number;
};

const SHEETS: readonly SheetDef[] = [
  { key: 'tree_fruit', path: '/sprites/tiles/tree_fruit.png?v=2', frameWidth: 48, frameHeight: 48 },
  { key: 'tree_vine', path: '/sprites/tiles/tree_vine.png?v=2', frameWidth: 48, frameHeight: 48 },
  { key: 'tree_wood', path: '/sprites/tiles/tree_wood.png?v=2', frameWidth: 48, frameHeight: 48 },
  { key: 'bushes', path: '/sprites/tiles/bushes.png?v=4', frameWidth: 16, frameHeight: 16 },
  { key: 'bushes_big', path: '/sprites/tiles/bushes.png?v=4', frameWidth: 32, frameHeight: 16 },
  { key: 'fireplace', path: '/sprites/tiles/fireplace.png?v=3', frameWidth: 16, frameHeight: 16, animFrames: 4, fps: 6 },
  { key: 'fireplace_off', path: '/sprites/tiles/fireplace_off.png?v=1', frameWidth: 16, frameHeight: 16 },
  { key: 'items', path: '/sprites/tiles/items.png?v=7', frameWidth: 16, frameHeight: 16 },
  { key: 'boulder', path: '/sprites/tiles/boulder.png?v=1', frameWidth: 32, frameHeight: 32 },
  { key: 'chicken_walk', path: '/sprites/tiles/chicken.png', frameWidth: 16, frameHeight: 16, animFrames: 6, fps: 6 },
  { key: 'fish_idle', path: '/sprites/animals/fish_idle.png?v=3', frameWidth: 16, frameHeight: 16, animFrames: 5, fps: 5 },
] as const;

const missing = new Set<string>();

// Describes how a resource maps onto a sprite frame plus the visual footprint.
// `anchorY` is the pixel fraction of the sprite aligned to the tile's bottom-centre:
//   0.5 → sprite centre on tile centre (single-tile entities like fire/chicken).
//   1.0 → sprite bottom sits on the tile's bottom (multi-tile entities like tree/bush).
export type ResourceVisual = {
  sheetKey: string;
  frame: number;
  anchorX: number; // fraction of sprite width aligned to tile's horizontal centre
  anchorY: number; // fraction of sprite height aligned to tile's vertical centre/bottom
  animate: boolean;
  // Extra y-depth offset, in pixels, added to the sprite's rendered y position when sorting.
  // Positive values push the sprite further "into the foreground" (renders above later items).
  depthOffset: number;
  // Optional top-layer sprite (e.g. tree canopy) drawn at the same tile origin.
  // `depthBias` is added on top of the base sprite's y so the overlay renders above
  // normal y-sorted entities (characters cap around y≈1000, so 10_000 keeps canopies on top).
  overlay?: {
    sheetKey: string;
    frame: number;
    anchorX: number;
    anchorY: number;
    depthBias: number;
  };
  // Per-resource decorations (e.g. fruit/berry icons rendered on top of the
  // base sprite to indicate yield count visually). Positions are in pixels
  // relative to the base sprite's anchored (x, y).
  decorations?: Array<{
    sheetKey: string;
    frame: number;
    dx: number;
    dy: number;
    scale: number;
    depthBias: number;
  }>;
  // Optional tint applied to the base sprite (Phaser setTint). 0xffffff = no
  // tint. Used for visual state changes that don't justify a separate sheet
  // (e.g. unlit fire = gray dim of the lit frame).
  tint?: number;
  // Optional alpha (Phaser setAlpha). 1 = opaque (default). Used to blend
  // entities into their environment (e.g. fish into water).
  alpha?: number;
};

export function preloadResourceSprites(scene: Phaser.Scene): void {
  scene.load.on('loaderror', (file: Phaser.Loader.File) => {
    missing.add(file.key);
  });
  for (const def of SHEETS) {
    scene.load.spritesheet(def.key, def.path, {
      frameWidth: def.frameWidth,
      frameHeight: def.frameHeight,
    });
  }
}

export function registerResourceAnimations(scene: Phaser.Scene): void {
  for (const def of SHEETS) {
    if (!def.animFrames || def.animFrames < 2) continue;
    if (missing.has(def.key)) continue;
    if (!scene.textures.exists(def.key)) continue;
    if (scene.anims.exists(def.key)) continue;
    scene.anims.create({
      key: def.key,
      frames: scene.anims.generateFrameNumbers(def.key, { start: 0, end: def.animFrames - 1 }),
      frameRate: def.fps ?? 6,
      repeat: -1,
    });
  }
}

// Decide sprite + frame for a resource, or null when asset is missing (caller falls back to shape).
export function visualFor(scene: Phaser.Scene, r: Resource): ResourceVisual | null {
  switch (r.type) {
    case 'tree_fruit':
    case 'tree_vine':
    case 'tree_wood': {
      const sheetKey = r.type; // matches sheet keys 1:1
      if (!available(scene, sheetKey)) return null;
      // Decorations: only tree_fruit shows yield count (fruits dangling from canopy).
      // tree_vine/tree_wood express stash visually via the canopy art itself.
      const decos: NonNullable<ResourceVisual['decorations']> = [];
      if (r.type === 'tree_fruit' && available(scene, 'items')) {
        const fruits = Number(r.state?.fruits ?? 0);
        if (fruits > 0) {
          const radius = fruits === 1 ? 0 : 7;
          for (let i = 0; i < fruits; i++) {
            const a = (i / Math.max(1, fruits)) * Math.PI * 2;
            decos.push({
              sheetKey: 'items',
              frame: 0,
              dx: Math.cos(a) * radius,
              dy: -32 + Math.sin(a) * radius * 0.4,
              scale: 1,
              depthBias: 10001,
            });
          }
        }
      }
      return {
        sheetKey,
        frame: 0,
        anchorX: 0.5,
        anchorY: 1,
        animate: false,
        depthOffset: 0,
        overlay: {
          sheetKey,
          frame: 1,
          anchorX: 0.5,
          anchorY: 1,
          depthBias: 10000,
        },
        decorations: decos.length > 0 ? decos : undefined,
      };
    }
    case 'wood': {
      if (!available(scene, 'items')) return null;
      // items.png frame 2 = chopped wood log, sitting on the ground (centre-anchor).
      return { sheetKey: 'items', frame: 2, anchorX: 0.5, anchorY: 0.5, animate: false, depthOffset: 0 };
    }
    case 'fruit': {
      if (!available(scene, 'items')) return null;
      // items.png frame 0 = fruit, sitting where it fell from the canopy.
      return { sheetKey: 'items', frame: 0, anchorX: 0.5, anchorY: 0.5, animate: false, depthOffset: 0 };
    }
    case 'branch': {
      // Reuse wood log frame until a dedicated branch sprite lands.
      if (!available(scene, 'items')) return null;
      return { sheetKey: 'items', frame: 2, anchorX: 0.5, anchorY: 0.5, animate: false, depthOffset: 0 };
    }
    case 'vine': {
      if (!available(scene, 'items')) return null;
      // items.png frame 3 = vine.
      return { sheetKey: 'items', frame: 3, anchorX: 0.5, anchorY: 0.5, animate: false, depthOffset: 0 };
    }
    case 'stone': {
      if (!available(scene, 'items')) return null;
      // items.png frame 4 = stone (bottom-row, first column).
      return { sheetKey: 'items', frame: 4, anchorX: 0.5, anchorY: 0.5, animate: false, depthOffset: 0 };
    }
    case 'boulder': {
      if (!available(scene, 'boulder')) return null;
      // 32×32 sprite, bottom-anchored to occupy its tile + extend upward.
      return { sheetKey: 'boulder', frame: 0, anchorX: 0.5, anchorY: 1, animate: false, depthOffset: 0 };
    }
    case 'bush': {
      if (!available(scene, 'bushes')) return null;
      // Barren bushes use the big 2-tile sprite (decorative-looking, never
      // produces berries). Productive bushes use the small sprite: frame 2
      // (berry puff) when berries > 0, frame 3 (empty dome) when depleted.
      const barren = Boolean(r.state?.barren);
      if (barren && available(scene, 'bushes_big')) {
        return { sheetKey: 'bushes_big', frame: 0, anchorX: 0.5, anchorY: 1, animate: false, depthOffset: 0 };
      }
      const berries = Number(r.state?.berries ?? 0);
      const berryDecos: NonNullable<ResourceVisual['decorations']> = [];
      if (berries > 0 && available(scene, 'items')) {
        // Bush is 16×16 anchored at tile bottom; berries sit on the dome top
        // (~10 px above anchor). Angle starts at 0 (right) so n=2 spreads side
        // by side instead of stacking vertically.
        const radius = berries === 1 ? 0 : 4;
        for (let i = 0; i < berries; i++) {
          const a = (i / Math.max(1, berries)) * Math.PI * 2;
          berryDecos.push({
            sheetKey: 'items',
            frame: 1,
            dx: Math.cos(a) * radius,
            dy: -10 + Math.sin(a) * radius * 0.35,
            scale: 1,
            depthBias: 100, // above bush body, but well below tree canopy
          });
        }
      }
      return {
        sheetKey: 'bushes',
        frame: berries > 0 ? 2 : 3,
        anchorX: 0.5,
        anchorY: 1,
        animate: false,
        depthOffset: 0,
        decorations: berryDecos.length > 0 ? berryDecos : undefined,
      };
    }
    case 'fire': {
      const lit = Boolean(r.state?.lit ?? true);
      const sheetKey = lit ? 'fireplace' : 'fireplace_off';
      if (!available(scene, sheetKey)) return null;
      return {
        sheetKey,
        frame: 0,
        anchorX: 0.5,
        anchorY: 0.5,
        animate: lit,
        depthOffset: 0,
      };
    }
    case 'animal_chicken': {
      if (!available(scene, 'chicken_walk')) return null;
      return { sheetKey: 'chicken_walk', frame: 0, anchorX: 0.5, anchorY: 0.5, animate: true, depthOffset: 0 };
    }
    case 'animal_fish': {
      if (!available(scene, 'fish_idle')) return null;
      return { sheetKey: 'fish_idle', frame: 0, anchorX: 0.5, anchorY: 0.5, animate: true, depthOffset: 0, alpha: 0.75 };
    }
    default:
      return null;
  }
}

function available(scene: Phaser.Scene, key: string): boolean {
  return !missing.has(key) && scene.textures.exists(key);
}
