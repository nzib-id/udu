import type Database from 'better-sqlite3';
import type { Glossary, GlossaryTag } from '../../shared/types.js';
import { BASIC_KNOWN_TYPES } from '../../shared/config.js';

type GlossaryRow = {
  character_id: number;
  resource_type: string;
  tags: string;
  observed_at: number;
};

// Phase 3 glossary persistence. One row per (char, type) — tags JSON-encoded.
// Lineage inheritance: on respawn, parent's full glossary is copied to child.
// Empty glossary (gen 0) is the natural starting state; no seed is written.
export class GlossaryRepo {
  constructor(private db: Database.Database) {}

  load(characterId: number): Glossary {
    const rows = this.db
      .prepare('SELECT * FROM character_glossary WHERE character_id = ?')
      .all(characterId) as GlossaryRow[];
    const out: Glossary = {};
    for (const r of rows) {
      try {
        const tags = JSON.parse(r.tags) as GlossaryTag[];
        out[r.resource_type] = tags;
      } catch {
        // Bad JSON shouldn't happen, but skip gracefully.
      }
    }
    return out;
  }

  // Upsert one type's tag set. Replaces existing tags if any. Used by observe.
  upsert(characterId: number, resourceType: string, tags: GlossaryTag[], nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO character_glossary (character_id, resource_type, tags, observed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(character_id, resource_type) DO UPDATE SET
           tags = excluded.tags,
           observed_at = excluded.observed_at`,
      )
      .run(characterId, resourceType, JSON.stringify(tags), nowMs);
  }

  // Seed gen 0 / fresh-load with auto-known basic types (river, etc.). Idempotent
  // — uses ON CONFLICT DO NOTHING so existing entries (e.g. inherited from
  // parent) aren't overwritten.
  seedBaseline(characterId: number, nowMs: number): void {
    const stmt = this.db.prepare(
      `INSERT INTO character_glossary (character_id, resource_type, tags, observed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(character_id, resource_type) DO NOTHING`,
    );
    const tx = this.db.transaction(() => {
      for (const [type, tags] of Object.entries(BASIC_KNOWN_TYPES)) {
        stmt.run(characterId, type, JSON.stringify(tags), nowMs);
      }
    });
    tx();
  }

  // Lineage: copy every entry from `fromCharacterId` to `toCharacterId`. Called
  // once on respawn so the new gen inherits parent's full knowledge.
  inherit(fromCharacterId: number, toCharacterId: number, nowMs: number): number {
    const rows = this.db
      .prepare('SELECT resource_type, tags FROM character_glossary WHERE character_id = ?')
      .all(fromCharacterId) as Pick<GlossaryRow, 'resource_type' | 'tags'>[];
    if (rows.length === 0) return 0;
    const stmt = this.db.prepare(
      `INSERT INTO character_glossary (character_id, resource_type, tags, observed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(character_id, resource_type) DO NOTHING`,
    );
    const tx = this.db.transaction(() => {
      for (const r of rows) stmt.run(toCharacterId, r.resource_type, r.tags, nowMs);
    });
    tx();
    return rows.length;
  }
}
