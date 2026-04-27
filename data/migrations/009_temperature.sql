-- Phase 5: Temperature stat. Per-character body temperature, drifts toward
-- ambient (phase-dependent: morning/afternoon/evening/night). Fire radius
-- override when nearby fire is lit. Drains drives (hunger/thirst/energy)
-- when out of comfort range — indirect pipeline to HP via existing
-- HEALTH_CONFIG drain rules. Default 25°C (comfort midpoint).
ALTER TABLE character ADD COLUMN temperature REAL NOT NULL DEFAULT 25;
