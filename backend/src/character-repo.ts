import type Database from 'better-sqlite3';
import type { Character, Position } from '../../shared/types.js';
import { CHARACTER_CONFIG } from '../../shared/config.js';

type CharacterRow = {
  id: number;
  lineage_id: number;
  iteration: number;
  spawn_time: number;
  x: number;
  y: number;
  hunger: number;
  thirst: number;
  bladder: number;
  energy: number;
  sickness: number;
  inventory: string;
  current_action: string;
  is_alive: number;
  life_goal_text: string | null;
  life_goal_reason: string | null;
  life_goal_priority: number | null;
  life_goal_set_at_day: number | null;
};

export class CharacterRepo {
  constructor(private db: Database.Database) {}

  ensureLineage(): number {
    const row = this.db.prepare('SELECT id FROM lineage ORDER BY id ASC LIMIT 1').get() as
      | { id: number }
      | undefined;
    if (row) return row.id;
    const info = this.db
      .prepare('INSERT INTO lineage (started_at, current_iteration) VALUES (?, 1)')
      .run(Date.now());
    return Number(info.lastInsertRowid);
  }

  loadActive(): Character | null {
    const row = this.db
      .prepare('SELECT * FROM character WHERE is_alive = 1 ORDER BY id DESC LIMIT 1')
      .get() as CharacterRow | undefined;
    return row ? rowToCharacter(row) : null;
  }

  spawn(lineageId: number, iteration: number, position?: Position): Character {
    const now = Date.now();
    const x = position?.x ?? CHARACTER_CONFIG.spawnX;
    const y = position?.y ?? CHARACTER_CONFIG.spawnY;
    const info = this.db
      .prepare(
        `INSERT INTO character (lineage_id, iteration, spawn_time, x, y)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(lineageId, iteration, now, x, y);
    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare('SELECT * FROM character WHERE id = ?').get(id) as CharacterRow;
    return rowToCharacter(row);
  }

  incrementIteration(lineageId: number): number {
    this.db
      .prepare('UPDATE lineage SET current_iteration = current_iteration + 1 WHERE id = ?')
      .run(lineageId);
    const row = this.db
      .prepare('SELECT current_iteration FROM lineage WHERE id = ?')
      .get(lineageId) as { current_iteration: number } | undefined;
    return row?.current_iteration ?? 1;
  }

  recordDeath(
    characterId: number,
    deathTime: number,
    reason: 'starvation' | 'dehydration' | 'admin',
    lifespanGameHours: number,
  ): void {
    this.db
      .prepare(
        `UPDATE character SET
           is_alive = 0,
           death_time = ?,
           death_reason = ?,
           lifespan_game_hours = ?
         WHERE id = ?`,
      )
      .run(deathTime, reason, lifespanGameHours, characterId);
  }

  persist(c: Character): void {
    this.db
      .prepare(
        `UPDATE character SET
           x = ?, y = ?,
           hunger = ?, thirst = ?, bladder = ?, energy = ?, sickness = ?,
           inventory = ?, current_action = ?, is_alive = ?,
           life_goal_text = ?, life_goal_reason = ?,
           life_goal_priority = ?, life_goal_set_at_day = ?
         WHERE id = ?`,
      )
      .run(
        c.position.x,
        c.position.y,
        c.stats.hunger,
        c.stats.thirst,
        c.stats.bladder,
        c.stats.energy,
        c.stats.sickness ?? 0,
        JSON.stringify(c.inventory),
        JSON.stringify(c.currentAction),
        c.isAlive ? 1 : 0,
        c.lifeGoal?.text ?? null,
        c.lifeGoal?.reason ?? null,
        c.lifeGoal?.priority ?? null,
        c.lifeGoal?.setAtDay ?? null,
        c.id,
      );
  }
}

function rowToCharacter(row: CharacterRow): Character {
  const lifeGoal =
    row.life_goal_text && row.life_goal_reason && row.life_goal_priority != null && row.life_goal_set_at_day != null
      ? {
          text: row.life_goal_text,
          reason: row.life_goal_reason,
          priority: row.life_goal_priority,
          setAtDay: row.life_goal_set_at_day,
        }
      : null;
  return {
    id: row.id,
    iteration: row.iteration,
    spawnedAt: row.spawn_time,
    position: { x: row.x, y: row.y },
    stats: {
      hunger: row.hunger,
      thirst: row.thirst,
      bladder: row.bladder,
      energy: row.energy,
      sickness: row.sickness,
    },
    inventory: safeJsonArray(row.inventory),
    currentAction: safeJsonAction(row.current_action),
    isAlive: row.is_alive === 1,
    facing: 0,
    lifeGoal,
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

function safeJsonAction(s: string): Character['currentAction'] {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && typeof v.type === 'string') return v as Character['currentAction'];
  } catch {
    /* ignore */
  }
  return { type: 'idle', startedAt: 0 };
}
