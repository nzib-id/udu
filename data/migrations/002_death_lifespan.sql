-- Phase 5: persist death info on character row.
-- death_time = real ms when killed; death_reason = 'starvation' | 'dehydration' | 'admin';
-- lifespan_game_hours = game-hours alive between spawn_time and death_time.
ALTER TABLE character ADD COLUMN death_time INTEGER;
ALTER TABLE character ADD COLUMN death_reason TEXT;
ALTER TABLE character ADD COLUMN lifespan_game_hours REAL;
