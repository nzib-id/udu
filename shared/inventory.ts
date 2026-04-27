import { INVENTORY_WEIGHTS, MAX_INVENTORY_WEIGHT } from './config.js';

// Weight of a single item type. Unknown items default to 0 (e.g. quest items
// added later) — fail-open so legacy inventories can't crash on lookup.
export function weightOfItem(item: string): number {
  return INVENTORY_WEIGHTS[item] ?? 0;
}

export function totalWeight(inv: readonly string[]): number {
  let w = 0;
  for (const item of inv) w += weightOfItem(item);
  return w;
}

// Can we add `item` without exceeding MAX? True when current + new ≤ cap.
// Caller still uses .push() — this is purely a gate.
export function canCarry(inv: readonly string[], item: string): boolean {
  return totalWeight(inv) + weightOfItem(item) <= MAX_INVENTORY_WEIGHT;
}

export function remainingCapacity(inv: readonly string[]): number {
  return Math.max(0, MAX_INVENTORY_WEIGHT - totalWeight(inv));
}

// Compact `["wood","wood","berry"]` → `[{item:"wood",count:2},{item:"berry",count:1}]`
// preserving stable order of first appearance. Used by HUD + LLM prompt.
export function groupInventory(inv: readonly string[]): Array<{ item: string; count: number }> {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const it of inv) {
    if (!counts.has(it)) order.push(it);
    counts.set(it, (counts.get(it) ?? 0) + 1);
  }
  return order.map((item) => ({ item, count: counts.get(item)! }));
}
