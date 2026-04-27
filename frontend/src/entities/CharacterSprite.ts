import Phaser from 'phaser';
import { MAP_CONFIG, NETWORK_CONFIG } from '../../../shared/config';
import type { Character } from '../../../shared/types';

// Backend streams continuous float positions once per broadcast — tween bridges the gap.
const MOVE_TWEEN_MS = NETWORK_CONFIG.stateBroadcastMs;

type SpriteDef = { key: string; path: string; frames: number; fps: number; loop: boolean };

const SPRITE_DEFS: readonly SpriteDef[] = [
  { key: 'man_idle', path: '/sprites/char/man_idle.png?v=2', frames: 4, fps: 4, loop: true },
  { key: 'man_walk', path: '/sprites/char/man_walk.png?v=2', frames: 4, fps: 8, loop: true },
  { key: 'man_bow', path: '/sprites/char/man_bow.png?v=2', frames: 6, fps: 8, loop: false },
  { key: 'man_sit', path: '/sprites/char/man_sit.png?v=2', frames: 4, fps: 4, loop: true },
  { key: 'man_use', path: '/sprites/char/man_use.png?v=2', frames: 2, fps: 6, loop: true },
  { key: 'man_reach_up', path: '/sprites/char/man_reach_up.png?v=2', frames: 4, fps: 6, loop: false },
  { key: 'man_shake', path: '/sprites/char/man_shake.png?v=2', frames: 2, fps: 8, loop: true },
  { key: 'man_swing', path: '/sprites/char/man_swing.png?v=2', frames: 4, fps: 8, loop: false },
  { key: 'man_sleep', path: '/sprites/char/man_sleep.png?v=2', frames: 4, fps: 3, loop: true },
  { key: 'man_die', path: '/sprites/char/man_die.png?v=2', frames: 6, fps: 6, loop: false },
] as const;

export function preloadCharacterSprites(scene: Phaser.Scene): void {
  for (const def of SPRITE_DEFS) {
    scene.load.spritesheet(def.key, def.path, { frameWidth: 16, frameHeight: 16 });
  }
}

export function registerCharacterAnimations(scene: Phaser.Scene): void {
  for (const def of SPRITE_DEFS) {
    if (scene.anims.exists(def.key)) continue;
    scene.anims.create({
      key: def.key,
      frames: scene.anims.generateFrameNumbers(def.key, { start: 0, end: def.frames - 1 }),
      frameRate: def.fps,
      repeat: def.loop ? -1 : 0,
    });
  }
}

export class CharacterSprite {
  private sprite: Phaser.GameObjects.Sprite;
  private fromTile: { x: number; y: number };
  private toTile: { x: number; y: number };
  private stepStartMs = 0;
  private lastFacingRight = true;
  private currentAnim = 'man_idle';

  constructor(scene: Phaser.Scene, initial: Character) {
    const { tileSize } = MAP_CONFIG;
    this.fromTile = { x: initial.position.x, y: initial.position.y };
    this.toTile = { x: initial.position.x, y: initial.position.y };
    const px = tileSize / 2;
    this.sprite = scene.add.sprite(
      initial.position.x * tileSize + px,
      initial.position.y * tileSize + px,
      'man_idle',
    );
    this.sprite.setOrigin(0.5, 0.5);
    this.sprite.setDepth(this.sprite.y);
    this.play('man_idle');
  }

  update(_dt: number, character: Character): void {
    const { tileSize } = MAP_CONFIG;
    const nowMs = performance.now();

    // New continuous position from server → start a fresh lerp from the sprite's
    // current rendered pixel pos so mid-tween updates stay smooth.
    if (character.position.x !== this.toTile.x || character.position.y !== this.toTile.y) {
      const curFracX = (this.sprite.x - tileSize / 2) / tileSize;
      const curFracY = (this.sprite.y - tileSize / 2) / tileSize;
      this.fromTile = { x: curFracX, y: curFracY };
      this.toTile = { x: character.position.x, y: character.position.y };
      this.stepStartMs = nowMs;
    }

    const stepDist = Math.hypot(this.toTile.x - this.fromTile.x, this.toTile.y - this.fromTile.y);
    // Scale tween duration with step distance — backend's last leg before reaching
    // a target is often a fraction of a tile, and a fixed 500ms lerp on 0.3 tiles
    // makes the sprite crawl while the walk animation runs at full speed
    // ("jalan di tempat"). Full step (2.5 t/s × 500ms = 1.25 tiles) keeps full duration;
    // shorter steps lerp proportionally faster, with a 100ms floor for stability.
    const tweenMs = stepDist > 0
      ? Math.max(100, Math.min(MOVE_TWEEN_MS, (stepDist / 1.25) * MOVE_TWEEN_MS))
      : MOVE_TWEEN_MS;

    const t = Math.min(1, (nowMs - this.stepStartMs) / tweenMs);
    const fx = this.fromTile.x + (this.toTile.x - this.fromTile.x) * t;
    const fy = this.fromTile.y + (this.toTile.y - this.fromTile.y) * t;
    this.sprite.x = fx * tileSize + tileSize / 2;
    this.sprite.y = fy * tileSize + tileSize / 2;
    this.sprite.setDepth(this.sprite.y);

    const dxDir = this.toTile.x - this.fromTile.x;
    if (Math.abs(dxDir) > 0.01) {
      this.lastFacingRight = dxDir > 0;
      this.sprite.setFlipX(!this.lastFacingRight);
    }

    // Walk animation follows VISUAL movement, not backend's action label. Backend
    // flips action → idle/eat the same tick it consumes the final waypoint, but the
    // sprite still has lerp left toward destination — keep walking until it arrives.
    const isMoving = t < 1 && stepDist > 0.02;
    const desiredAnim = isMoving && character.isAlive ? 'man_walk' : this.animFor(character);
    if (desiredAnim !== this.currentAnim) {
      this.play(desiredAnim);
    }

    const s = character.stats;
    const lemes = s.hunger < 20 || s.thirst < 20 || s.energy < 20;
    this.sprite.setTint(lemes ? 0x8a7a6a : 0xffffff);
  }

  private animFor(character: Character): string {
    if (!character.isAlive) return 'man_die';
    switch (character.currentAction.type) {
      case 'walk_to':
      case 'wander':
        // Sprite is stationary but backend still labels the action as walking
        // (transient gap between lerp finish and next broadcast). Show idle so
        // the walk animation doesn't run in place.
        return 'man_idle';
      case 'sleep':
        return 'man_sleep';
      case 'defecate':
      case 'rest':
        return 'man_sit';
      case 'eat':
      case 'drink':
        return 'man_use';
      case 'shake':
        return 'man_shake';
      case 'pickup':
        return 'man_bow';
      case 'hunt':
        return 'man_swing';
      case 'cook':
        return 'man_bow';
      case 'idle':
      default:
        return 'man_idle';
    }
  }

  private play(key: string): void {
    this.currentAnim = key;
    this.sprite.play(key, true);
  }

  gameObject(): Phaser.GameObjects.Sprite {
    return this.sprite;
  }
}
