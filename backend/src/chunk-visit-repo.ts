import type Database from 'better-sqlite3';

export type ChunkVisit = {
  cx: number;
  cy: number;
  visitCount: number;
  lastVisitT: number;
};

type Row = {
  chunk_x: number;
  chunk_y: number;
  visit_count: number;
  last_visit_t: number;
};

export class ChunkVisitRepo {
  constructor(private db: Database.Database) {}

  loadFor(characterId: number): ChunkVisit[] {
    const rows = this.db
      .prepare(
        'SELECT chunk_x, chunk_y, visit_count, last_visit_t FROM chunk_visit WHERE character_id = ?',
      )
      .all(characterId) as Row[];
    return rows.map((r) => ({
      cx: r.chunk_x,
      cy: r.chunk_y,
      visitCount: r.visit_count,
      lastVisitT: r.last_visit_t,
    }));
  }

  upsert(characterId: number, cx: number, cy: number, lastVisitT: number): void {
    this.db
      .prepare(
        `INSERT INTO chunk_visit (character_id, chunk_x, chunk_y, visit_count, last_visit_t)
         VALUES (?, ?, ?, 1, ?)
         ON CONFLICT(character_id, chunk_x, chunk_y) DO UPDATE SET
           visit_count = visit_count + 1,
           last_visit_t = excluded.last_visit_t`,
      )
      .run(characterId, cx, cy, lastVisitT);
  }

  clearFor(characterId: number): void {
    this.db.prepare('DELETE FROM chunk_visit WHERE character_id = ?').run(characterId);
  }
}
