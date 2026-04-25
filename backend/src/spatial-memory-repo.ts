import type Database from 'better-sqlite3';
import type { Resource, ResourceType } from '../../shared/types.js';

export type RememberedResource = {
  resourceId: string;
  type: ResourceType;
  x: number;
  y: number;
  lastSeenT: number;
};

type Row = {
  resource_id: string;
  type: string;
  x: number;
  y: number;
  last_seen_t: number;
};

export class SpatialMemoryRepo {
  constructor(private db: Database.Database) {}

  loadFor(characterId: number): RememberedResource[] {
    const rows = this.db
      .prepare(
        'SELECT resource_id, type, x, y, last_seen_t FROM spatial_memory WHERE character_id = ?',
      )
      .all(characterId) as Row[];
    return rows.map((r) => ({
      resourceId: r.resource_id,
      type: r.type as ResourceType,
      x: r.x,
      y: r.y,
      lastSeenT: r.last_seen_t,
    }));
  }

  upsert(characterId: number, resource: Resource, lastSeenT: number): void {
    this.db
      .prepare(
        `INSERT INTO spatial_memory (character_id, resource_id, type, x, y, last_seen_t)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(character_id, resource_id) DO UPDATE SET
           type = excluded.type,
           x = excluded.x,
           y = excluded.y,
           last_seen_t = excluded.last_seen_t`,
      )
      .run(characterId, resource.id, resource.type, resource.x, resource.y, lastSeenT);
  }

  upsertBatch(characterId: number, resources: Resource[], lastSeenT: number): void {
    if (resources.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO spatial_memory (character_id, resource_id, type, x, y, last_seen_t)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(character_id, resource_id) DO UPDATE SET
         type = excluded.type,
         x = excluded.x,
         y = excluded.y,
         last_seen_t = excluded.last_seen_t`,
    );
    const txn = this.db.transaction((rows: Resource[]) => {
      for (const r of rows) stmt.run(characterId, r.id, r.type, r.x, r.y, lastSeenT);
    });
    txn(resources);
  }

  removeMissing(characterId: number, knownIds: Iterable<string>, currentResourceIds: Set<string>): string[] {
    // When a remembered resource ID no longer exists in the world (e.g. fruit
    // picked up, animal hunted) AND the character was in a position to confirm
    // its absence, drop it from memory. Caller decides which IDs to forget;
    // this just runs the deletes and reports back what was removed.
    const removed: string[] = [];
    const stmt = this.db.prepare(
      'DELETE FROM spatial_memory WHERE character_id = ? AND resource_id = ?',
    );
    const txn = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        if (!currentResourceIds.has(id)) {
          stmt.run(characterId, id);
          removed.push(id);
        }
      }
    });
    txn(Array.from(knownIds));
    return removed;
  }

  forget(characterId: number, resourceId: string): void {
    this.db
      .prepare('DELETE FROM spatial_memory WHERE character_id = ? AND resource_id = ?')
      .run(characterId, resourceId);
  }

  clearFor(characterId: number): void {
    this.db.prepare('DELETE FROM spatial_memory WHERE character_id = ?').run(characterId);
  }
}
