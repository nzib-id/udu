// Persistent storage of natural-language rules learned across deaths — the
// "spirit memory" of a lineage. Each entry is one sentence emitted by the
// reflection LLM (e.g. "Eating raw meat causes sickness"). Rules are
// lineage-scoped so generations within the same lineage inherit them, but
// new lineages start blank.
//
// MVP semantics: all reflection-emitted rules are inserted as `active=1`. On
// each save we cap active rules at MAX_ACTIVE_RULES by deactivating the
// lowest-confidence ones — keeps the feed prompt lean. No fancy semantic
// merging: if the LLM emits a duplicate idea, both rows live until pruning.

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const MAX_ACTIVE_RULES = 10;

export type Rule = {
  id: string;
  text: string;
  confidence: number;
  learnedAtDay: number;
  learnedAtIteration: number;
};

type RuleRow = {
  id: string;
  text: string | null;
  confidence: number;
  learned_at_day: number | null;
  inherited_from_generation: number | null;
};

export class RuleRepo {
  constructor(private db: Database.Database) {}

  /**
   * Active, high-confidence rules for this lineage, ordered most-trusted first.
   * Caller injects these into the feed prompt as the "Lessons" block.
   */
  loadActive(lineageId: number): Rule[] {
    const rows = this.db
      .prepare(
        `SELECT id, text, confidence, learned_at_day, inherited_from_generation
         FROM rule
         WHERE lineage_id = ? AND active = 1 AND text IS NOT NULL
         ORDER BY confidence DESC
         LIMIT ?`,
      )
      .all(lineageId, MAX_ACTIVE_RULES) as RuleRow[];
    return rows.map(rowToRule);
  }

  /**
   * Insert new rules from a reflection cycle, then prune so at most
   * MAX_ACTIVE_RULES rows remain active for this lineage. Pruning deactivates
   * the lowest-confidence rules — they're kept on disk for audit but stop
   * appearing in the feed prompt.
   */
  save(
    lineageId: number,
    iteration: number,
    learnedAtDay: number,
    rules: Array<{ text: string; confidence: number }>,
  ): number {
    if (rules.length === 0) return 0;
    const insert = this.db.prepare(
      `INSERT INTO rule (
         id, lineage_id, condition, effect, weight_delta, affected_actions,
         confidence, inherited_from_generation, created_at, text,
         active, learned_at_day
       ) VALUES (?, ?, '', '', 0, '[]', ?, ?, ?, ?, 1, ?)`,
    );
    const tx = this.db.transaction(() => {
      let n = 0;
      for (const r of rules) {
        insert.run(randomUUID(), lineageId, r.confidence, iteration, Date.now(), r.text, learnedAtDay);
        n++;
      }
      this.pruneActive(lineageId);
      return n;
    });
    return tx();
  }

  private pruneActive(lineageId: number): void {
    // Deactivate everything beyond top-N by confidence (descending). Ties are
    // broken by created_at DESC so newer wins on equal confidence.
    this.db
      .prepare(
        `UPDATE rule
         SET active = 0
         WHERE lineage_id = ?
           AND active = 1
           AND id NOT IN (
             SELECT id FROM rule
             WHERE lineage_id = ? AND active = 1 AND text IS NOT NULL
             ORDER BY confidence DESC, created_at DESC
             LIMIT ?
           )`,
      )
      .run(lineageId, lineageId, MAX_ACTIVE_RULES);
  }
}

function rowToRule(row: RuleRow): Rule {
  return {
    id: row.id,
    text: row.text ?? '',
    confidence: row.confidence,
    learnedAtDay: row.learned_at_day ?? 0,
    learnedAtIteration: row.inherited_from_generation ?? 0,
  };
}
