-- Phase 4 reflection: extend rule table for the LLM-prompt-injection
-- architecture. Original columns (condition/effect/weight_delta/affected_actions)
-- targeted utility-weight modulation, which we replaced with an LLM choice
-- picker that reads natural-language rules + observation log. New columns:
--   text            — the full natural-language rule, exactly as the model
--                     emits it. Injected into the feed prompt as a "Lessons
--                     from past lives" line.
--   active          — 0 = superseded / pruned, 1 = currently injected.
--   learned_at_day  — game-day the reflection cycle that produced this rule.
ALTER TABLE rule ADD COLUMN text TEXT;
ALTER TABLE rule ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rule ADD COLUMN learned_at_day INTEGER;

CREATE INDEX IF NOT EXISTS idx_rule_lineage_active ON rule(lineage_id, active);
