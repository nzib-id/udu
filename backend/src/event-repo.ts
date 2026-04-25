import type Database from 'better-sqlite3';

export type EventRow = {
  id: number;
  character_id: number | null;
  game_time: string;
  real_time: number;
  event_type: string;
  payload: string;
};

export class EventRepo {
  constructor(private db: Database.Database) {}

  log(
    characterId: number | null,
    gameTime: string,
    eventType: string,
    payload: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare(
        `INSERT INTO event (character_id, game_time, real_time, event_type, payload)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(characterId, gameTime, Date.now(), eventType, JSON.stringify(payload));
  }

  /** Events newer than `sinceMs` (real time), ordered oldest-first. Used by
   *  the reflection cycle to feed the day's history to the LLM. */
  loadSince(sinceMs: number, limit = 500): EventRow[] {
    return this.db
      .prepare(
        `SELECT id, character_id, game_time, real_time, event_type, payload
         FROM event
         WHERE real_time >= ?
         ORDER BY real_time ASC
         LIMIT ?`,
      )
      .all(sinceMs, limit) as EventRow[];
  }
}
