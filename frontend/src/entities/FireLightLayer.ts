import Phaser from 'phaser';
import { FIRE_CONFIG, MAP_CONFIG } from '../../../shared/config';
import type { GameTime, Resource } from '../../../shared/types';

// Per-lit-fire warm light pool. Drawn ABOVE the DayNightLayer overlay using an
// additive blend so the dark-blue night tint gets lifted to a warm orange in
// the area around each lit fire — a visible oasis in the dark.
//
// Implementation: a single pre-rendered radial-gradient texture (transparent
// edge → warm core) is reused for every fire as an additive Image. Smooth
// soft edges, no banded fillCircle stack.

const LIGHT_RADIUS_TILES = FIRE_CONFIG.warmthRadius + 0.5;
const MAX_ALPHA = 0.55;
const TEXTURE_KEY = 'fire-light-glow';

// Returns 0..1 — 0 = full daylight (no glow), 1 = deepest night.
function darknessAtHour(hourFloat: number): number {
  const h = ((hourFloat % 24) + 24) % 24;
  if (h >= 19 || h < 6) return 1;
  if (h >= 6 && h < 7) return 1 - (h - 6);
  if (h >= 17 && h < 19) return (h - 17) / 2;
  return 0;
}

export class FireLightLayer {
  private resources: Resource[] = [];
  private images = new Map<string, Phaser.GameObjects.Image>();
  private diameterPx: number;

  constructor(private scene: Phaser.Scene) {
    this.diameterPx = LIGHT_RADIUS_TILES * MAP_CONFIG.tileSize * 2;
    ensureGlowTexture(scene, this.diameterPx);
  }

  setResources(resources: Resource[]): void {
    this.resources = resources;
  }

  update(time: GameTime): void {
    const hourFloat = time.hour + time.minute / 60;
    const dark = darknessAtHour(hourFloat);
    const alpha = dark * MAX_ALPHA;

    const liveIds = new Set<string>();
    if (dark > 0) {
      for (const r of this.resources) {
        if (r.type !== 'fire') continue;
        if (r.state?.lit === false) continue;
        liveIds.add(r.id);
        const cx = (r.x + 0.5) * MAP_CONFIG.tileSize;
        const cy = (r.y + 0.5) * MAP_CONFIG.tileSize;
        let img = this.images.get(r.id);
        if (!img) {
          img = this.scene.add.image(cx, cy, TEXTURE_KEY);
          img.setBlendMode(Phaser.BlendModes.ADD);
          img.setDepth(1_000_001); // above DayNightLayer (1_000_000)
          this.images.set(r.id, img);
        } else {
          img.setPosition(cx, cy);
        }
        img.setAlpha(alpha);
      }
    }

    for (const [id, img] of this.images) {
      if (!liveIds.has(id)) {
        img.destroy();
        this.images.delete(id);
      }
    }
  }
}

function ensureGlowTexture(scene: Phaser.Scene, diameter: number): void {
  if (scene.textures.exists(TEXTURE_KEY)) return;
  const canvas = scene.textures.createCanvas(TEXTURE_KEY, diameter, diameter);
  if (!canvas) return;
  const ctx = canvas.getContext();
  const cx = diameter / 2;
  const cy = diameter / 2;
  const r = diameter / 2;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  // Inner core hot, fades smoothly to transparent at the edge.
  grad.addColorStop(0.0, 'rgba(255, 200, 120, 1.0)');
  grad.addColorStop(0.35, 'rgba(255, 170, 85, 0.55)');
  grad.addColorStop(0.7, 'rgba(255, 140, 60, 0.18)');
  grad.addColorStop(1.0, 'rgba(255, 140, 60, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, diameter, diameter);
  canvas.refresh();
}
