-- Phase 4.7: life goal columns on character — "what is this life for".
-- Generated once on spawn via LLM (prompt-life-goal.ts) using a world summary
-- of currently-known resources, explored chunks, past death reasons, and
-- inventory. The LLM must reference only entities that exist in the world
-- summary (referenced_entities validation) — no hallucinated goals.
--
-- Priority is self-rated 1-10 by the LLM based on need vs. opportunity. The
-- daily reflection cycle can revise the goal (achievement → new, or rephrase).
-- Wiped with the character on death (no migration needed — character row goes).
ALTER TABLE character ADD COLUMN life_goal_text TEXT;
ALTER TABLE character ADD COLUMN life_goal_reason TEXT;
ALTER TABLE character ADD COLUMN life_goal_priority INTEGER;
ALTER TABLE character ADD COLUMN life_goal_set_at_day INTEGER;
