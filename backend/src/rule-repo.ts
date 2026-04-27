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

// Confidence decay parameters — see applyConfidenceDecay(). Values picked so a
// rule that goes untested for a full game-week dies (0.99 - 0.05*7 = 0.64), and
// a starting-0.55 rule dies in 3 days. Tunable if observed too aggressive.
const CONFIRMED_BOOST = 0.05;
const UNTESTED_DECAY = 0.05;
const CONFIDENCE_FLOOR = 0.40;
const CONFIDENCE_CEIL = 0.99;

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

  /**
   * Wipe-and-reinsert active rule set for this lineage. Used by the reflection
   * cycle after applyConfidenceDecay produces the merged final list — the
   * decay output IS the new state, not an additional layer. Old rows are kept
   * on disk (active=0) for audit.
   */
  replaceActive(
    lineageId: number,
    iteration: number,
    learnedAtDay: number,
    rules: Array<{ text: string; confidence: number }>,
  ): number {
    const deactivate = this.db.prepare(
      `UPDATE rule SET active = 0 WHERE lineage_id = ? AND active = 1`,
    );
    const insert = this.db.prepare(
      `INSERT INTO rule (
         id, lineage_id, condition, effect, weight_delta, affected_actions,
         confidence, inherited_from_generation, created_at, text,
         active, learned_at_day
       ) VALUES (?, ?, '', '', 0, '[]', ?, ?, ?, ?, 1, ?)`,
    );
    const tx = this.db.transaction(() => {
      deactivate.run(lineageId);
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

/**
 * Merge LLM reflection output with prior rules using the prior_idx self-tag:
 *  - prior_idx valid + same text → "confirmed" → boost prior confidence
 *  - prior_idx valid + new text  → "refined"   → take LLM's confidence
 *  - prior_idx null              → "new rule"  → take LLM's confidence
 *  - prior NOT referenced anywhere → "untested" → decay -0.05
 *  - confidence below floor       → drop
 *
 * Caps at 0.99 (no absolute claims). Output is the lineage's full new active
 * set — caller passes to replaceActive(), no additional prior preservation.
 *
 * Output is deduped by normalized text (case-insensitive trim). Without this,
 * the LLM emitting the same rule twice with prior_idx=null produces two rows
 * that both survive pruning — bloats the prompt and overweights the idea.
 * On collision the higher confidence wins (a confirmed boost beats a fresh
 * mid-confidence emit).
 */
export function applyConfidenceDecay(
  priorRules: Rule[],
  newRules: Array<{ text: string; confidence: number; prior_idx: number | null }>,
): Array<{ text: string; confidence: number }> {
  const seenPriorIdx = new Set<number>();
  const byText = new Map<string, { text: string; confidence: number }>();
  const norm = (s: string) => s.trim().toLowerCase();

  const upsert = (text: string, confidence: number) => {
    const k = norm(text);
    const existing = byText.get(k);
    if (!existing || confidence > existing.confidence) {
      byText.set(k, { text, confidence });
    }
  };

  for (const r of newRules) {
    if (r.prior_idx !== null && r.prior_idx >= 0 && r.prior_idx < priorRules.length) {
      seenPriorIdx.add(r.prior_idx);
      const prior = priorRules[r.prior_idx];
      const textMatch = norm(r.text) === norm(prior.text);
      const newConf = textMatch
        ? Math.min(CONFIDENCE_CEIL, prior.confidence + CONFIRMED_BOOST)
        : r.confidence;
      upsert(r.text, newConf);
    } else {
      // prior_idx null/invalid: still treat as a confirmation if the text
      // matches an existing prior (LLM forgot to set prior_idx but emitted
      // the same idea). Prevents silent duplicate inserts.
      const matchIdx = priorRules.findIndex((p) => norm(p.text) === norm(r.text));
      if (matchIdx >= 0) {
        seenPriorIdx.add(matchIdx);
        const boosted = Math.min(CONFIDENCE_CEIL, priorRules[matchIdx].confidence + CONFIRMED_BOOST);
        upsert(r.text, boosted);
      } else {
        upsert(r.text, r.confidence);
      }
    }
  }

  // Untested priors — not referenced by any new rule. Decay; drop below floor.
  for (let i = 0; i < priorRules.length; i++) {
    if (seenPriorIdx.has(i)) continue;
    const decayed = priorRules[i].confidence - UNTESTED_DECAY;
    if (decayed >= CONFIDENCE_FLOOR) {
      upsert(priorRules[i].text, decayed);
    }
  }

  return Array.from(byText.values());
}
