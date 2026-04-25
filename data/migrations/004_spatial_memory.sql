-- Phase 4.5: spatial memory — per-character "I have seen X at (x,y)" log.
-- Lokasi memory is reset on death (DELETE WHERE character_id = deceased) but
-- persists across server restart so a live character doesn't lose its mental
-- map when the backend container reboots. Object property knowledge (effect of
-- actions) lives in the rule table via reflection — this table only holds the
-- spatial side: type + position of resources the character has personally
-- spotted within its vision cone.
CREATE TABLE IF NOT EXISTS spatial_memory (
  character_id INTEGER NOT NULL REFERENCES character(id),
  resource_id TEXT NOT NULL,
  type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  last_seen_t INTEGER NOT NULL,
  PRIMARY KEY (character_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_spatial_memory_char ON spatial_memory(character_id);
