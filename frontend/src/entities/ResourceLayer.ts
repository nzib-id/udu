import Phaser from 'phaser';
import { MAP_CONFIG, NETWORK_CONFIG } from '../../../shared/config';
import type { Resource } from '../../../shared/types';
import { visualFor, type ResourceVisual } from './SpriteRegistry';

const COLOR_RIVER_RIPPLE = 0x6db3d8;
const COLOR_BUSH = 0x1f4f24;
const COLOR_BUSH_BERRY = 0xc33a3a;
const COLOR_TREE_TRUNK = 0x4a3523;
const COLOR_TREE_CANOPY = 0x2d6830;
const COLOR_TREE_FRUIT = 0xe3a53a;
const COLOR_WOOD = 0x8a6a3a;
const COLOR_FIRE_OUTER = 0xe07030;
const COLOR_FIRE_INNER = 0xf3d04a;
const COLOR_CHICKEN_BODY = 0xd9cfa8;
const COLOR_CHICKEN_COMB = 0xc03a3a;
const COLOR_CHICKEN_BEAK = 0xe0a040;
const COLOR_FISH = 0xb0d0e8;

// Server emits continuous chicken positions per broadcast — tween just smooths across that interval.
const MOVE_TWEEN_MS = NETWORK_CONFIG.stateBroadcastMs;
// River tiles are painted by TerrainLayer; here we only track their positions for the ripple overlay.
const RIVER_TYPES = new Set<Resource['type']>(['river']);

type EntityGo = Phaser.GameObjects.Graphics | Phaser.GameObjects.Sprite;
type Entity = {
  type: Resource['type'];
  go: EntityGo;
  // Top-layer sprite (e.g. tree canopy) — optional, mirrors go's x/y so the
  // canopy sits on the trunk but renders above characters via depthBias.
  overlay: Phaser.GameObjects.Sprite | null;
  // Yield-count decorations (fruit/berry icons on top of tree/bush). Rebuilt
  // whenever the resource state signature changes.
  decorations: Phaser.GameObjects.Sprite[];
  isSprite: boolean;
  visual: ResourceVisual | null;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  stepStartMs: number;
  lastSignature: string;
  phase: number;
  lastFacingRight: boolean;
  // For shape fallback we need per-resource overlay redraws on state change (berries count, fruits count).
  lastResource: Resource;
};

const TREE_FADE_ALPHA = 0.35;
const TREE_FADE_LERP = 0.18;

export class ResourceLayer {
  private rippleGfx: Phaser.GameObjects.Graphics;
  private entities = new Map<string, Entity>();
  private riverTiles: Array<{ x: number; y: number }> = [];
  // Tree currently being shaken by the character (server action `shake_tree`).
  // Canopy rotates while this is set; reset to null once action ends.
  private shakingTreeId: string | null = null;
  private shakeTween: Phaser.Tweens.Tween | null = null;
  private charTileX = -999;
  private charTileY = -999;

  constructor(private scene: Phaser.Scene) {
    this.rippleGfx = scene.add.graphics();
    // Ripple floats just above the terrain atlas (depth 0) but well below any entity/character.
    this.rippleGfx.setDepth(1);
  }

  setShakingTree(treeId: string | null): void {
    if (this.shakingTreeId === treeId) return;
    // Stop the previous tween and restore upright canopy.
    if (this.shakeTween) {
      this.shakeTween.stop();
      this.shakeTween = null;
    }
    if (this.shakingTreeId) {
      const prev = this.entities.get(this.shakingTreeId);
      if (prev?.overlay) prev.overlay.setRotation(0);
    }
    this.shakingTreeId = treeId;
    if (!treeId) return;
    const ent = this.entities.get(treeId);
    if (!ent?.overlay) return;
    // Wiggle the canopy ±0.08 rad (~4.5°) at ~7 Hz while the action is active.
    this.shakeTween = this.scene.tweens.add({
      targets: ent.overlay,
      rotation: { from: -0.08, to: 0.08 },
      duration: 140,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.inOut',
    });
  }

  setCharacterTile(tx: number, ty: number): void {
    this.charTileX = tx;
    this.charTileY = ty;
  }

  render(resources: Resource[]): void {
    this.riverTiles = resources.filter((r) => RIVER_TYPES.has(r.type)).map((r) => ({ x: r.x, y: r.y }));

    const seen = new Set<string>();
    const nowMs = performance.now();
    const { tileSize } = MAP_CONFIG;

    for (const r of resources) {
      if (RIVER_TYPES.has(r.type)) continue; // TerrainLayer owns river visuals.
      seen.add(r.id);
      const existing = this.entities.get(r.id);
      const sig = `${r.x},${r.y}:${JSON.stringify(r.state ?? {})}`;

      if (!existing) {
        const visual = visualFor(this.scene, r);
        const go = this.createEntityGo(r, visual, tileSize);
        const overlay = this.createOverlaySprite(r, visual, tileSize);
        const decorations = this.createDecorations(r, visual, tileSize);
        this.entities.set(r.id, {
          type: r.type,
          go,
          overlay,
          decorations,
          isSprite: visual !== null,
          visual,
          fromX: r.x,
          fromY: r.y,
          toX: r.x,
          toY: r.y,
          stepStartMs: nowMs,
          lastSignature: sig,
          phase: Math.random() * Math.PI * 2,
          lastFacingRight: true,
          lastResource: r,
        });
        // Fruit that just fell from a tree — drop it from ~1 tile above with a bounce.
        if (r.type === 'fruit_on_ground' && visual) {
          const landY = go.y;
          go.y = landY - tileSize;
          this.scene.tweens.add({
            targets: go,
            y: landY,
            duration: 450,
            ease: 'Bounce.Out',
          });
        }
        continue;
      }

      if (r.x !== existing.toX || r.y !== existing.toY) {
        const prevVisualCx = existing.isSprite ? existing.go.x : existing.go.x + tileSize / 2;
        const prevVisualCy = existing.isSprite
          ? existing.go.y - (existing.visual ? (existing.visual.anchorY - 0.5) * visualHeight(existing) : 0)
          : existing.go.y + tileSize / 2;
        existing.fromX = (prevVisualCx - tileSize / 2) / tileSize;
        existing.fromY = (prevVisualCy - tileSize / 2) / tileSize;
        if (r.type === 'animal_chicken') {
          const dx = r.x - existing.toX;
          if (dx !== 0) existing.lastFacingRight = dx > 0;
        }
        existing.toX = r.x;
        existing.toY = r.y;
        existing.stepStartMs = nowMs;
      }

      if (sig !== existing.lastSignature) {
        existing.lastSignature = sig;
        existing.lastResource = r;
        const nextVisual = visualFor(this.scene, r);
        const visualChanged =
          nextVisual?.sheetKey !== existing.visual?.sheetKey ||
          nextVisual?.frame !== existing.visual?.frame;
        if (visualChanged) {
          existing.go.destroy();
          existing.overlay?.destroy();
          const go = this.createEntityGo(r, nextVisual, tileSize);
          existing.go = go;
          existing.overlay = this.createOverlaySprite(r, nextVisual, tileSize);
          existing.isSprite = nextVisual !== null;
          existing.visual = nextVisual;
        } else if (!existing.isSprite) {
          const g = existing.go as Phaser.GameObjects.Graphics;
          g.clear();
          drawShapeBody(g, r, tileSize);
        } else {
          // Same base sprite — but decoration count (fruits/berries) may have
          // changed. Refresh the cached visual ref so tweenEntities sees the
          // new decoration positions.
          existing.visual = nextVisual;
        }
        for (const d of existing.decorations) d.destroy();
        existing.decorations = this.createDecorations(r, nextVisual, tileSize);
      }
    }

    for (const [id, ent] of this.entities) {
      if (!seen.has(id)) {
        ent.go.destroy();
        ent.overlay?.destroy();
        for (const d of ent.decorations) d.destroy();
        this.entities.delete(id);
      }
    }
  }

  private createDecorations(
    r: Resource,
    visual: ResourceVisual | null,
    ts: number,
  ): Phaser.GameObjects.Sprite[] {
    if (!visual?.decorations || visual.decorations.length === 0) return [];
    const baseX = r.x * ts + ts / 2;
    const baseY = r.y * ts + ts * visual.anchorY;
    const sprites: Phaser.GameObjects.Sprite[] = [];
    for (const d of visual.decorations) {
      const sprite = this.scene.add.sprite(baseX + d.dx, baseY + d.dy, d.sheetKey, d.frame);
      sprite.setOrigin(0.5, 0.5);
      sprite.setScale(d.scale);
      sprite.setDepth(baseY + d.depthBias);
      sprites.push(sprite);
    }
    return sprites;
  }

  private createOverlaySprite(
    r: Resource,
    visual: ResourceVisual | null,
    ts: number,
  ): Phaser.GameObjects.Sprite | null {
    if (!visual?.overlay) return null;
    const { sheetKey, frame, anchorX, anchorY, depthBias } = visual.overlay;
    const sprite = this.scene.add.sprite(
      r.x * ts + ts / 2,
      r.y * ts + ts * anchorY,
      sheetKey,
      frame,
    );
    sprite.setOrigin(anchorX, anchorY);
    sprite.setDepth(sprite.y + depthBias);
    return sprite;
  }

  // Called every frame by MapScene — drives ambient flicker/ripple + tween interp.
  tick(nowMs: number): void {
    this.tweenEntities(nowMs);
    this.animateFireShape(nowMs);
    this.animateFish(nowMs);
    this.animateRipple(nowMs);
  }

  private createEntityGo(r: Resource, visual: ResourceVisual | null, ts: number): EntityGo {
    if (visual) {
      const sprite = this.scene.add.sprite(
        r.x * ts + ts / 2,
        r.y * ts + ts * visual.anchorY,
        visual.sheetKey,
        visual.frame,
      );
      sprite.setOrigin(visual.anchorX, visual.anchorY);
      sprite.setDepth(sprite.y + visual.depthOffset);
      if (visual.animate && this.scene.anims.exists(visual.sheetKey)) sprite.play(visual.sheetKey, true);
      return sprite;
    }
    // Shape fallback — draws at (0,0) in its own graphics coordinate space.
    const g = this.scene.add.graphics();
    g.x = r.x * ts;
    g.y = r.y * ts;
    g.setDepth(g.y + ts);
    drawShapeBody(g, r, ts);
    return g;
  }

  private tweenEntities(nowMs: number): void {
    const { tileSize } = MAP_CONFIG;
    for (const ent of this.entities.values()) {
      if (ent.fromX !== ent.toX || ent.fromY !== ent.toY) {
        const duration = ent.type === 'animal_chicken' ? MOVE_TWEEN_MS : 300;
        const raw = Math.min(1, (nowMs - ent.stepStartMs) / duration);
        const t = raw < 0.5 ? 2 * raw * raw : 1 - Math.pow(-2 * raw + 2, 2) / 2;
        const fx = ent.fromX + (ent.toX - ent.fromX) * t;
        const fy = ent.fromY + (ent.toY - ent.fromY) * t;
        positionEntity(ent, fx, fy, tileSize);
        if (ent.type === 'animal_chicken' && ent.isSprite) {
          (ent.go as Phaser.GameObjects.Sprite).setFlipX(!ent.lastFacingRight);
        }
      }
      // Always refresh depth in case nearby entities have shifted (cheap, avoids z-fighting).
      ent.go.setDepth(depthFor(ent, tileSize));
      if (ent.overlay && ent.visual?.overlay) {
        ent.overlay.x = ent.go.x;
        ent.overlay.y = ent.go.y;
        ent.overlay.setDepth(ent.go.y + ent.visual.overlay.depthBias);
      }
      // Tree fade: lerp trunk + canopy alpha when character occupies same tile.
      if (ent.type === 'tree') {
        const dx = Math.abs(ent.toX - this.charTileX);
        const dy = Math.abs(ent.toY - this.charTileY);
        const target = dx <= 1 && dy <= 1 ? TREE_FADE_ALPHA : 1;
        const cur = ent.go.alpha;
        const next = cur + (target - cur) * TREE_FADE_LERP;
        ent.go.setAlpha(next);
        if (ent.overlay) ent.overlay.setAlpha(next);
      }
      if (ent.decorations.length > 0 && ent.visual?.decorations) {
        for (let i = 0; i < ent.decorations.length; i++) {
          const dec = ent.decorations[i];
          const cfg = ent.visual.decorations[i];
          if (!cfg) continue;
          dec.x = ent.go.x + cfg.dx;
          dec.y = ent.go.y + cfg.dy;
          dec.setDepth(ent.go.y + cfg.depthBias);
        }
      }
    }
  }

  // Only the shape-fallback fire needs manual flicker; the animated spritesheet handles its own.
  private animateFireShape(nowMs: number): void {
    const { tileSize: ts } = MAP_CONFIG;
    for (const ent of this.entities.values()) {
      if (ent.type !== 'fire' || ent.isSprite) continue;
      const g = ent.go as Phaser.GameObjects.Graphics;
      const flicker = 1 + Math.sin(nowMs / 120 + ent.phase) * 0.08 + Math.sin(nowMs / 53 + ent.phase) * 0.06;
      g.clear();
      g.fillStyle(COLOR_FIRE_OUTER, 1);
      g.fillCircle(ts / 2, ts / 2, (ts / 3) * flicker);
      g.fillStyle(COLOR_FIRE_INNER, 1);
      g.fillCircle(ts / 2, ts / 2, (ts / 5) * flicker);
    }
  }

  private animateFish(nowMs: number): void {
    const { tileSize } = MAP_CONFIG;
    for (const ent of this.entities.values()) {
      if (ent.type !== 'animal_fish') continue;
      if (ent.fromX !== ent.toX || ent.fromY !== ent.toY) continue;
      const wiggle = Math.sin(nowMs / 280 + ent.phase) * 1.2;
      const baseX = ent.isSprite ? ent.toX * tileSize + tileSize / 2 : ent.toX * tileSize;
      ent.go.x = baseX + wiggle;
    }
  }

  private animateRipple(nowMs: number): void {
    if (this.riverTiles.length === 0) return;
    const { tileSize } = MAP_CONFIG;
    const g = this.rippleGfx;
    g.clear();
    g.fillStyle(COLOR_RIVER_RIPPLE, 0.25);
    for (let i = 0; i < 8; i++) {
      const base = this.riverTiles[(i * 7) % this.riverTiles.length];
      const t = (nowMs / 1800 + i * 0.13) % 1;
      const offsetY = t * tileSize - tileSize / 2;
      const size = 1.5 + Math.sin(nowMs / 600 + i) * 0.6;
      g.fillCircle(base.x * tileSize + tileSize / 2, base.y * tileSize + offsetY, size);
    }
  }
}

function visualHeight(ent: Entity): number {
  if (!ent.isSprite) return MAP_CONFIG.tileSize;
  return (ent.go as Phaser.GameObjects.Sprite).height;
}

function depthFor(ent: Entity, ts: number): number {
  if (ent.isSprite) {
    // Sprite's y already points at the tile's anchored row — use that directly so tall sprites
    // (tree trunks) sort by where they "stand" rather than where their canopy floats.
    return ent.go.y + (ent.visual?.depthOffset ?? 0);
  }
  return ent.go.y + ts;
}

function positionEntity(ent: Entity, fx: number, fy: number, ts: number): void {
  if (ent.isSprite && ent.visual) {
    ent.go.x = fx * ts + ts / 2;
    ent.go.y = fy * ts + ts * ent.visual.anchorY;
  } else {
    ent.go.x = fx * ts;
    ent.go.y = fy * ts;
  }
}

// Shape fallback — used when the sprite atlas failed to load. Drawn at graphics-origin (0,0).
function drawShapeBody(g: Phaser.GameObjects.Graphics, r: Resource, ts: number): void {
  switch (r.type) {
    case 'bush': {
      g.fillStyle(COLOR_BUSH, 1);
      g.fillCircle(ts / 2, ts / 2, ts / 2 - 1);
      const berries = Number(r.state?.berries ?? 0);
      g.fillStyle(COLOR_BUSH_BERRY, 1);
      for (let i = 0; i < berries; i++) {
        const a = (i / Math.max(1, berries)) * Math.PI * 2;
        g.fillCircle(ts / 2 + Math.cos(a) * (ts / 4), ts / 2 + Math.sin(a) * (ts / 4), 1.2);
      }
      return;
    }
    case 'tree': {
      g.fillStyle(COLOR_TREE_TRUNK, 1);
      g.fillRect(ts / 2 - 1, ts - 5, 2, 5);
      g.fillStyle(COLOR_TREE_CANOPY, 1);
      g.fillCircle(ts / 2, ts / 2 - 1, ts / 2);
      const fruits = Number(r.state?.fruits ?? 0);
      g.fillStyle(COLOR_TREE_FRUIT, 1);
      for (let i = 0; i < fruits; i++) {
        const a = (i / Math.max(1, fruits)) * Math.PI * 2 + Math.PI / 6;
        g.fillCircle(ts / 2 + Math.cos(a) * (ts / 3), ts / 2 - 1 + Math.sin(a) * (ts / 3), 1.4);
      }
      return;
    }
    case 'wood': {
      g.fillStyle(COLOR_WOOD, 1);
      g.fillRect(3, ts / 2 - 1, ts - 6, 2);
      return;
    }
    case 'fire': {
      g.fillStyle(COLOR_FIRE_OUTER, 1);
      g.fillCircle(ts / 2, ts / 2, ts / 3);
      g.fillStyle(COLOR_FIRE_INNER, 1);
      g.fillCircle(ts / 2, ts / 2, ts / 5);
      return;
    }
    case 'animal_chicken': {
      g.fillStyle(COLOR_CHICKEN_BODY, 1);
      g.fillCircle(ts / 2, ts / 2 + 1, ts / 3);
      g.fillCircle(ts / 2 + 2, ts / 2 - 2, ts / 5);
      g.fillStyle(COLOR_CHICKEN_COMB, 1);
      g.fillCircle(ts / 2 + 2, ts / 2 - 4, 1.2);
      g.fillStyle(COLOR_CHICKEN_BEAK, 1);
      g.fillRect(ts / 2 + 4, ts / 2 - 2, 2, 1);
      return;
    }
    case 'animal_fish': {
      g.fillStyle(COLOR_FISH, 1);
      g.fillCircle(ts / 2, ts / 2, ts / 4);
      g.fillTriangle(
        ts / 2 - ts / 4, ts / 2,
        ts / 2 - ts / 3, ts / 2 - 2,
        ts / 2 - ts / 3, ts / 2 + 2,
      );
      return;
    }
    default:
      return;
  }
}
