-- Phase 1: initial schema (character, lineage, rule, event, resource_state, reflection)
-- Applied by backend/src/db.ts when PRAGMA user_version < 1.

CREATE TABLE IF NOT EXISTS lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  current_iteration INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS character (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lineage_id INTEGER NOT NULL REFERENCES lineage(id),
  iteration INTEGER NOT NULL,
  spawn_time INTEGER NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  hunger REAL NOT NULL DEFAULT 100,
  thirst REAL NOT NULL DEFAULT 100,
  bladder REAL NOT NULL DEFAULT 0,
  energy REAL NOT NULL DEFAULT 100,
  sickness REAL NOT NULL DEFAULT 0,
  inventory TEXT NOT NULL DEFAULT '[]',
  current_action TEXT NOT NULL DEFAULT '{"type":"idle","startedAt":0}',
  is_alive INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_character_alive ON character(is_alive);

CREATE TABLE IF NOT EXISTS rule (
  id TEXT PRIMARY KEY,
  lineage_id INTEGER NOT NULL REFERENCES lineage(id),
  condition TEXT NOT NULL,
  effect TEXT NOT NULL,
  weight_delta REAL NOT NULL DEFAULT 0,
  affected_actions TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0.5,
  inherited_from_generation INTEGER,
  created_at INTEGER NOT NULL,
  last_triggered_at INTEGER,
  times_triggered INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  game_time TEXT NOT NULL,
  real_time INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_event_character_time ON event(character_id, real_time);

CREATE TABLE IF NOT EXISTS resource_state (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  x REAL NOT NULL,
  y REAL NOT NULL,
  state TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS reflection (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  character_id INTEGER REFERENCES character(id),
  game_day INTEGER NOT NULL,
  real_time INTEGER NOT NULL,
  input_log TEXT NOT NULL,
  raw_output TEXT NOT NULL,
  parsed_rules TEXT NOT NULL,
  duration_ms INTEGER NOT NULL
);
