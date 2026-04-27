import type { Position, Resource } from '../../shared/types.js';
import { MAP_CONFIG, VISION_CONFIG } from '../../shared/config.js';

export type VisionResult = {
  tilesInCone: Set<string>;
  visibleResources: Resource[];
};

export type VisionOptions = {
  range: number;
  fovDegrees: number;
};

const DEG_TO_RAD = Math.PI / 180;

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Vision-only line-of-sight check. Mirrors pathfinder.hasLineOfSight but
// EXEMPTS the endpoint tile from the blocked check — we want to see the tree
// itself, not see-through it. Sampling the path back from the eye, any blocked
// tile between (exclusive of both endpoints) occludes vision.
function hasVisionToTile(charPos: Position, tile: Position, blocked: Set<string>): boolean {
  const dx = tile.x - charPos.x;
  const dy = tile.y - charPos.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return true;
  const steps = Math.ceil(dist * 4);
  const targetX = Math.round(tile.x);
  const targetY = Math.round(tile.y);
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const sx = Math.round(charPos.x + dx * t);
    const sy = Math.round(charPos.y + dy * t);
    if (sx === targetX && sy === targetY) continue;
    if (blocked.has(`${sx},${sy}`)) return false;
  }
  return true;
}

export function scanVision(
  charPos: Position,
  facing: number,
  resources: Resource[],
  blocked: Set<string>,
  options: VisionOptions,
): VisionResult {
  const result: VisionResult = { tilesInCone: new Set(), visibleResources: [] };
  const halfFov = (options.fovDegrees / 2) * DEG_TO_RAD;
  const range = options.range;
  const r2 = range * range;
  const cx = charPos.x;
  const cy = charPos.y;
  const minX = Math.max(0, Math.floor(cx - range));
  const maxX = Math.min(MAP_CONFIG.widthTiles - 1, Math.ceil(cx + range));
  const minY = Math.max(0, Math.floor(cy - range));
  const maxY = Math.min(MAP_CONFIG.heightTiles - 1, Math.ceil(cy + range));

  for (let ty = minY; ty <= maxY; ty++) {
    for (let tx = minX; tx <= maxX; tx++) {
      const dx = tx - cx;
      const dy = ty - cy;
      const dist2 = dx * dx + dy * dy;
      if (dist2 > r2) continue;
      if (dist2 < 0.25) {
        result.tilesInCone.add(`${tx},${ty}`);
        continue;
      }
      const angle = Math.atan2(dy, dx);
      const delta = normalizeAngle(angle - facing);
      if (Math.abs(delta) > halfFov) continue;
      if (!hasVisionToTile({ x: cx, y: cy }, { x: tx, y: ty }, blocked)) continue;
      result.tilesInCone.add(`${tx},${ty}`);
    }
  }

  for (const r of resources) {
    const key = `${Math.round(r.x)},${Math.round(r.y)}`;
    if (result.tilesInCone.has(key)) result.visibleResources.push(r);
  }

  return result;
}

export function isNight(hour: number): boolean {
  const { nightStart, nightEnd } = VISION_CONFIG;
  if (nightStart > nightEnd) return hour >= nightStart || hour < nightEnd;
  return hour >= nightStart && hour < nightEnd;
}

export function visionRangeForHour(hour: number, opts: { nearLitFire?: boolean } = {}): number {
  if (!isNight(hour)) return VISION_CONFIG.rangeDay;
  return opts.nearLitFire ? VISION_CONFIG.rangeNightNearFire : VISION_CONFIG.rangeNight;
}
