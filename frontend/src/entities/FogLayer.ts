import Phaser from 'phaser';
import { MAP_CONFIG } from '../../../shared/config';
import type { Character } from '../../../shared/types';

// Fog of war driven entirely by backend ground truth.
//
// The server sends two tile-key sets every state_update:
//   visibleTiles  — currently inside the LLM's vision cone (FOV + LOS, the
//                   exact same scan that drives spatial memory)
//   exploredTiles — cumulative union of every tile ever inside the cone this
//                   lifetime; cleared on respawn
//
// Frontend just renders. No local FOV/LOS math here on purpose: backend is
// the source of truth, fog must reflect what the AI actually perceived.
// Otherwise the viewer would fabricate exploration data and mislead anyone
// using fog as observation.
//
//   visible  → no overlay (transparent)
//   explored → dim overlay
//   unseen   → dark overlay
const ALPHA_UNSEEN = 0.78;
const ALPHA_EXPLORED = 0.42;

export class FogLayer {
  private graphics: Phaser.GameObjects.Graphics;
  private exploredTiles = new Set<string>();
  private currentVisible = new Set<string>();
  private enabled = true;

  constructor(private scene: Phaser.Scene) {
    this.graphics = scene.add.graphics();
    // Above DayNightLayer (1_000_000) and FireLightLayer so fog stays opaque
    // regardless of time-of-day tint. Below any DOM-based HUD layer.
    this.graphics.setDepth(1_500_000);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.graphics.setVisible(on);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  update(
    character: Character | null,
    visibleTiles: string[] | undefined,
    exploredTiles: string[] | undefined,
  ): void {
    if (!character) return;

    // Backend emits an empty `visibleTiles` array between vision scans (every
    // VISION_CONFIG.scanEveryTicks ticks). Treat that as "keep previous cone"
    // so the lit area doesn't flicker dark on off-scan ticks.
    if (visibleTiles && visibleTiles.length > 0) {
      this.currentVisible = new Set(visibleTiles);
    }
    if (exploredTiles) {
      this.exploredTiles = new Set(exploredTiles);
    }

    if (this.enabled) this.redraw();
  }

  private redraw(): void {
    const g = this.graphics;
    const { widthTiles, heightTiles, tileSize } = MAP_CONFIG;
    g.clear();
    for (let y = 0; y < heightTiles; y++) {
      for (let x = 0; x < widthTiles; x++) {
        const key = `${x},${y}`;
        if (this.currentVisible.has(key)) continue;
        const alpha = this.exploredTiles.has(key) ? ALPHA_EXPLORED : ALPHA_UNSEEN;
        g.fillStyle(0x000000, alpha);
        g.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
      }
    }
  }
}
