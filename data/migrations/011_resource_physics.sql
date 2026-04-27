-- Phase 2: items have continuous (x,y) + altitude z + velocity (vx,vy,vz).
-- Server-side physics tick simulates gravity until item settles. Static
-- sources (tree/bush/fire/river) keep z=0, all velocities 0. New items spawned
-- via tree shake / hunt / manual drop carry their initial physics state.
ALTER TABLE resource_state ADD COLUMN z REAL NOT NULL DEFAULT 0;
ALTER TABLE resource_state ADD COLUMN vx REAL NOT NULL DEFAULT 0;
ALTER TABLE resource_state ADD COLUMN vy REAL NOT NULL DEFAULT 0;
ALTER TABLE resource_state ADD COLUMN vz REAL NOT NULL DEFAULT 0;
