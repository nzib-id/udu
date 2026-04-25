import type { Position } from '../../shared/types.js';
import { MAP_CONFIG } from '../../shared/config.js';

const SQRT2 = Math.SQRT2;
const DIRS = [
  { x: 1, y: 0, cost: 1 },
  { x: -1, y: 0, cost: 1 },
  { x: 0, y: 1, cost: 1 },
  { x: 0, y: -1, cost: 1 },
  { x: 1, y: 1, cost: SQRT2 },
  { x: 1, y: -1, cost: SQRT2 },
  { x: -1, y: 1, cost: SQRT2 },
  { x: -1, y: -1, cost: SQRT2 },
];

type Node = { x: number; y: number; f: number };

function keyOf(x: number, y: number): string {
  return `${x},${y}`;
}

// Octile distance — admissible heuristic for 8-way movement with √2 diagonal cost.
function octile(a: Position, goals: Position[]): number {
  let best = Infinity;
  for (const g of goals) {
    const dx = Math.abs(a.x - g.x);
    const dy = Math.abs(a.y - g.y);
    const d = (dx + dy) + (SQRT2 - 2) * Math.min(dx, dy);
    if (d < best) best = d;
  }
  return best;
}

/**
 * A* on the map grid. Returns tiles from start (exclusive) to a goal (inclusive),
 * or null if unreachable.
 */
export function findPath(
  start: Position,
  goals: Position[],
  blocked: Set<string>,
): Position[] | null {
  if (goals.length === 0) return null;
  // Character positions are continuous floats — snap to the enclosing tile for grid search.
  const sx = Math.round(start.x);
  const sy = Math.round(start.y);
  const goalSet = new Set(goals.map((p) => keyOf(p.x, p.y)));
  if (goalSet.has(keyOf(sx, sy))) return [];

  const open: Node[] = [{ x: sx, y: sy, f: octile({ x: sx, y: sy }, goals) }];
  const gScore = new Map<string, number>();
  const cameFrom = new Map<string, string>();
  gScore.set(keyOf(sx, sy), 0);

  const { widthTiles, heightTiles } = MAP_CONFIG;

  while (open.length > 0) {
    // Pop lowest f — linear scan is fine for grids this size.
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const current = open.splice(bestIdx, 1)[0];
    const curKey = keyOf(current.x, current.y);
    if (goalSet.has(curKey)) return reconstruct(cameFrom, curKey);

    const curG = gScore.get(curKey)!;
    for (const d of DIRS) {
      const nx = current.x + d.x;
      const ny = current.y + d.y;
      if (nx < 0 || ny < 0 || nx >= widthTiles || ny >= heightTiles) continue;
      const nKey = keyOf(nx, ny);
      // Allow stepping onto a goal even if it's in `blocked` (shouldn't happen, but safe).
      if (blocked.has(nKey) && !goalSet.has(nKey)) continue;
      // Prevent diagonal corner-cutting through blocked tiles — if either orthogonal
      // neighbour is blocked we don't allow squeezing past it.
      if (d.x !== 0 && d.y !== 0) {
        const sideA = keyOf(current.x + d.x, current.y);
        const sideB = keyOf(current.x, current.y + d.y);
        if (blocked.has(sideA) && !goalSet.has(sideA)) continue;
        if (blocked.has(sideB) && !goalSet.has(sideB)) continue;
      }
      const tentative = curG + d.cost;
      if (tentative < (gScore.get(nKey) ?? Infinity)) {
        gScore.set(nKey, tentative);
        cameFrom.set(nKey, curKey);
        const f = tentative + octile({ x: nx, y: ny }, goals);
        // Remove stale entry if present to avoid duplicates.
        for (let i = 0; i < open.length; i++) {
          if (open[i].x === nx && open[i].y === ny) {
            open.splice(i, 1);
            break;
          }
        }
        open.push({ x: nx, y: ny, f });
      }
    }
  }
  return null;
}

function reconstruct(cameFrom: Map<string, string>, endKey: string): Position[] {
  const path: Position[] = [];
  let cur: string | undefined = endKey;
  while (cur && cameFrom.has(cur)) {
    const [x, y] = cur.split(',').map(Number);
    path.unshift({ x, y });
    cur = cameFrom.get(cur);
  }
  return path;
}

/**
 * Samples a straight line between two float points and returns false if any sampled
 * tile is in `blocked`. Used to collapse unnecessary grid waypoints into direct segments.
 */
export function hasLineOfSight(a: Position, b: Position, blocked: Set<string>): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 0.5) return true;
  const steps = Math.ceil(dist * 4);        // sample 4x per tile
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + dx * t;
    const y = a.y + dy * t;
    if (blocked.has(keyOf(Math.round(x), Math.round(y)))) return false;
  }
  return true;
}

/**
 * String-pulling path smoothing. Collapses consecutive grid waypoints into direct
 * segments whenever a straight line between them has unobstructed line of sight.
 * Result: character walks diagonally at any angle, not along grid edges.
 */
export function smoothPath(
  start: Position,
  path: Position[],
  blocked: Set<string>,
): Position[] {
  if (path.length <= 1) return path.slice();
  const out: Position[] = [];
  let anchor: Position = start;
  let i = 0;
  while (i < path.length) {
    // Find the farthest path[j] (j >= i) still reachable in a straight line from anchor.
    let j = i;
    for (let k = path.length - 1; k > i; k--) {
      if (hasLineOfSight(anchor, path[k], blocked)) {
        j = k;
        break;
      }
    }
    out.push(path[j]);
    anchor = path[j];
    i = j + 1;
  }
  return out;
}
