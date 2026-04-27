-- Lineage progression via reflective insight. Adds three columns to support
-- the diagnose+prescribe pattern for life-goal generation:
--
-- 1. life_goal_diagnosis — strategic insight the LLM produced about the lineage's
--    recurring failure pattern at the moment this goal was picked. Stored for
--    trace/debug; NOT injected into next-gen prompt (next gen diagnoses fresh
--    against raw trajectory data).
--
-- 2. chunks_visited_at_death / resources_discovered_at_death — snapshot counts
--    captured at recordDeath() time, before chunk_visit / spatial_memory get
--    wiped. Past gens' rows in those tables disappear on death, so without a
--    snapshot the lineage trajectory loses these signals. Used by world-summary
--    to give the LLM a "what did this gen actually accomplish" handle.
ALTER TABLE character ADD COLUMN life_goal_diagnosis TEXT;
ALTER TABLE character ADD COLUMN chunks_visited_at_death INTEGER;
ALTER TABLE character ADD COLUMN resources_discovered_at_death INTEGER;
