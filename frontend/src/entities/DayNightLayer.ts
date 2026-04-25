import Phaser from 'phaser';
import type { GameTime } from '../../../shared/types';

// Day/night cycle keyframes — fullscreen colour overlay rendered on top of the
// world to simulate ambient light. Hours wrap at 24, so the last keyframe must
// match hour 0 to keep the loop seamless.
type Keyframe = { hour: number; color: number; alpha: number };

const KEYFRAMES: ReadonlyArray<Keyframe> = [
  { hour: 0,  color: 0x0c1430, alpha: 0.70 }, // deep night
  { hour: 5,  color: 0x0c1430, alpha: 0.70 }, // night holds
  { hour: 6,  color: 0x3a2050, alpha: 0.55 }, // pre-dawn violet
  { hour: 7,  color: 0xff8855, alpha: 0.20 }, // sunrise warm
  { hour: 9,  color: 0xfff5d8, alpha: 0.05 }, // morning soft
  { hour: 15, color: 0xffffff, alpha: 0.00 }, // full day, no tint
  { hour: 17, color: 0xffd690, alpha: 0.08 }, // golden hour
  { hour: 18, color: 0xff5530, alpha: 0.30 }, // sunset
  { hour: 19, color: 0x2a1855, alpha: 0.55 }, // dusk
  { hour: 24, color: 0x0c1430, alpha: 0.70 }, // back to deep night
];

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

function sampleAtHour(hourFloat: number): { color: number; alpha: number } {
  const h = ((hourFloat % 24) + 24) % 24;
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const a = KEYFRAMES[i];
    const b = KEYFRAMES[i + 1];
    if (h >= a.hour && h <= b.hour) {
      const span = b.hour - a.hour;
      const t = span > 0 ? (h - a.hour) / span : 0;
      return {
        color: lerpColor(a.color, b.color, t),
        alpha: a.alpha + (b.alpha - a.alpha) * t,
      };
    }
  }
  return { color: KEYFRAMES[0].color, alpha: KEYFRAMES[0].alpha };
}

export class DayNightLayer {
  private rect: Phaser.GameObjects.Rectangle;

  constructor(private scene: Phaser.Scene) {
    // Rectangle placed in world coords; size + position recomputed each frame
    // to exactly cover the camera viewport regardless of zoom or scroll.
    // Depth is far above tree canopies (which use depthBias 10000).
    this.rect = scene.add.rectangle(0, 0, 1, 1, 0x000000, 0);
    this.rect.setOrigin(0, 0);
    this.rect.setDepth(1_000_000);
  }

  update(time: GameTime): void {
    const cam = this.scene.cameras.main;
    // Overcover by 32 screen pixels each side. Without this, camera follow lerp
    // + roundPixels can leave a 1-2px gap at the edges where the overlay drifts
    // a frame behind the camera scroll, exposing the un-tinted scene underneath.
    const marginPx = 32;
    const offset = marginPx / cam.zoom;
    const w = (cam.width + marginPx * 2) / cam.zoom;
    const h = (cam.height + marginPx * 2) / cam.zoom;
    this.rect.setPosition(cam.scrollX - offset, cam.scrollY - offset);
    this.rect.setSize(w, h);

    const hourFloat = time.hour + time.minute / 60;
    const { color, alpha } = sampleAtHour(hourFloat);
    this.rect.setFillStyle(color, alpha);
  }
}
