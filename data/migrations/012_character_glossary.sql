-- Phase 3: per-character glossary. Stores which ResourceTypes the char has
-- observed and what tags were revealed. Inherited from parent on respawn
-- (lineage progression). Empty for gen 0; observe action populates entries.
-- tags = JSON array of GlossaryTag literals ("edible","poisonous","drinkable","inedible").
CREATE TABLE IF NOT EXISTS character_glossary (
  character_id INTEGER NOT NULL,
  resource_type TEXT NOT NULL,
  tags TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (character_id, resource_type)
);

CREATE INDEX IF NOT EXISTS idx_character_glossary_char ON character_glossary(character_id);
