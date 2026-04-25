-- Phase 5: HP stat. Centralizes death funnel — drives at 0 drain HP instead of
-- per-stat 6-game-hour timer. Death = HP=0. Regen when thriving (all drives
-- satisfied + sickness low + awake). Reserved for future damage sources
-- (predator, fall, temperature) without bloating individual drives.
ALTER TABLE character ADD COLUMN health REAL NOT NULL DEFAULT 100;
