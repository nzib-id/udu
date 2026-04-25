-- Phase 4.6: chunk-level visit tracking — per-character "I have been here"
-- log at coarse spatial granularity. The map is divided into a grid of chunks
-- (see shared/spatial.ts). Each row records when (last_visit_t) and how often
-- (visit_count) the character occupied any tile inside that chunk. The wander
-- planner uses this to distinguish "unexplored area" (no row) from "stale
-- area" (row exists but last_visit_t is old) — without it, we mislabel
-- repeatedly-visited barren areas as "unexplored" because there are no
-- remembered resources nearby.
--
-- Reset on death (DELETE WHERE character_id = deceased) like spatial_memory:
-- each new generation rediscovers the world.
CREATE TABLE IF NOT EXISTS chunk_visit (
  character_id INTEGER NOT NULL REFERENCES character(id),
  chunk_x INTEGER NOT NULL,
  chunk_y INTEGER NOT NULL,
  visit_count INTEGER NOT NULL DEFAULT 0,
  last_visit_t INTEGER NOT NULL,
  PRIMARY KEY (character_id, chunk_x, chunk_y)
);

CREATE INDEX IF NOT EXISTS idx_chunk_visit_char ON chunk_visit(character_id);
