// Chunk-level spatial discretisation for the visited-area memory layer.
// The map (MAP_CONFIG.widthTiles × heightTiles) is partitioned into a grid of
// CHUNK_TILES × CHUNK_TILES tiles. Per-tile visit tracking would be wasteful
// (4800 tiles vs ~50 chunks) and per-quadrant would be too coarse. 5×5 chunks
// over a 40×30 map → 8×6 = 48 chunks, each ~5–10 ticks of walking to cross.
//
// Used by:
//   backend/src/chunk-visit-repo.ts  — persistence
//   backend/src/game-loop.ts         — per-tick visit upsert
//   backend/src/ai.ts                — wander annotation ("revisit" vs "unexplored")

import { MAP_CONFIG } from './config.js';

export const CHUNK_TILES = 5;

export type ChunkCoord = { cx: number; cy: number };

export function tileToChunk(tileX: number, tileY: number): ChunkCoord {
  return {
    cx: Math.floor(tileX / CHUNK_TILES),
    cy: Math.floor(tileY / CHUNK_TILES),
  };
}

export function chunkGridDims(): { cols: number; rows: number } {
  return {
    cols: Math.ceil(MAP_CONFIG.widthTiles / CHUNK_TILES),
    rows: Math.ceil(MAP_CONFIG.heightTiles / CHUNK_TILES),
  };
}

export function chunkKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}
