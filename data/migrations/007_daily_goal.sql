-- Phase 4.7 Layer 2: per-day daily goal — short-horizon plan that breaks the
-- life goal into 2-4 sequential sub-goals. Generated once per game-day boundary
-- (after reflection runs, so the prompt sees freshly-learned rules), persists
-- across day rollover so reflection can introspect "did yesterday's plan get
-- completed?" — useful signal for Layer 3 (Momentum).
--
-- alignment: how the plan relates to the life goal — 'advances' (pushes
-- forward), 'maintains' (recover/prep), or 'survival_override' (stats critical,
-- life goal paused). Tracked per row so the reflection cycle can detect "char
-- in survival_override 3 days running" and re-evaluate the life goal.
--
-- sub_goals: JSON array of {text, success_criteria, completed}. Sequential —
-- char advances current_step_idx as the LLM tags actions completes_subgoal=true.
-- When current_step_idx >= sub_goals.length, status flips to 'completed' and
-- the goal stops being injected into prompts (char free-roams until next day).
CREATE TABLE daily_goal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER NOT NULL REFERENCES character(id),
  day INTEGER NOT NULL,
  summary TEXT NOT NULL,
  reason TEXT NOT NULL,
  alignment TEXT NOT NULL CHECK (alignment IN ('advances', 'maintains', 'survival_override')),
  sub_goals TEXT NOT NULL,
  current_step_idx INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'abandoned')),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_daily_goal_char_day ON daily_goal(character_id, day DESC);
CREATE INDEX idx_daily_goal_active ON daily_goal(character_id, status);
