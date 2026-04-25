// Per-day plan storage. One row per game-day per character; `loadActive`
// returns the latest in_progress row for the live character (the one the LLM
// is told to advance). `markCompleted`/`markAbandoned` flip status without
// deleting — kept on disk so reflection can introspect history.

import type Database from 'better-sqlite3';
import type { Alignment, DailyGoal, SubGoal, SubGoalCheck } from '../../shared/types.js';

type DailyGoalRow = {
  id: number;
  character_id: number;
  day: number;
  summary: string;
  reason: string;
  alignment: string;
  sub_goals: string;
  current_step_idx: number;
  status: string;
  created_at: number;
};

export class DailyGoalRepo {
  constructor(private db: Database.Database) {}

  /** Most recent in-progress goal for this character, or null if none. */
  loadActive(characterId: number): DailyGoal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM daily_goal
         WHERE character_id = ? AND status = 'in_progress'
         ORDER BY day DESC, id DESC
         LIMIT 1`,
      )
      .get(characterId) as DailyGoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  /** Goal for a specific day — used by reflection to ask "did yesterday's plan
   *  finish?". Returns null when no row exists for that day. */
  loadForDay(characterId: number, day: number): DailyGoal | null {
    const row = this.db
      .prepare(
        `SELECT * FROM daily_goal
         WHERE character_id = ? AND day = ?
         ORDER BY id DESC
         LIMIT 1`,
      )
      .get(characterId, day) as DailyGoalRow | undefined;
    return row ? rowToGoal(row) : null;
  }

  /** Insert a new daily goal. Caller is responsible for marking any existing
   *  in_progress row as abandoned first (via markAbandoned) — repo doesn't
   *  enforce single-active. */
  create(input: {
    characterId: number;
    day: number;
    summary: string;
    reason: string;
    alignment: Alignment;
    subGoals: SubGoal[];
  }): DailyGoal {
    const subGoalsJson = JSON.stringify(input.subGoals.map(serializeSubGoal));
    const info = this.db
      .prepare(
        `INSERT INTO daily_goal
           (character_id, day, summary, reason, alignment, sub_goals,
            current_step_idx, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'in_progress', ?)`,
      )
      .run(
        input.characterId,
        input.day,
        input.summary,
        input.reason,
        input.alignment,
        subGoalsJson,
        Date.now(),
      );
    const id = Number(info.lastInsertRowid);
    const row = this.db.prepare('SELECT * FROM daily_goal WHERE id = ?').get(id) as DailyGoalRow;
    return rowToGoal(row);
  }

  /** Mark sub_goals[stepIdx].completed=true and bump current_step_idx. If the
   *  bump pushes past sub_goals.length, status flips to 'completed'. Returns
   *  the updated goal, or null if the row no longer matches in_progress. */
  advanceStep(goalId: number, stepIdx: number): DailyGoal | null {
    const row = this.db.prepare('SELECT * FROM daily_goal WHERE id = ?').get(goalId) as
      | DailyGoalRow
      | undefined;
    if (!row || row.status !== 'in_progress') return null;
    const subGoals = parseSubGoals(row.sub_goals);
    if (stepIdx < 0 || stepIdx >= subGoals.length) return null;
    if (stepIdx !== row.current_step_idx) return null;
    subGoals[stepIdx].completed = true;
    const nextIdx = row.current_step_idx + 1;
    const nextStatus = nextIdx >= subGoals.length ? 'completed' : 'in_progress';
    this.db
      .prepare(
        `UPDATE daily_goal
         SET sub_goals = ?, current_step_idx = ?, status = ?
         WHERE id = ?`,
      )
      .run(JSON.stringify(subGoals.map(serializeSubGoal)), nextIdx, nextStatus, goalId);
    const updated = this.db.prepare('SELECT * FROM daily_goal WHERE id = ?').get(goalId) as DailyGoalRow;
    return rowToGoal(updated);
  }

  markAbandoned(goalId: number): void {
    this.db
      .prepare(`UPDATE daily_goal SET status = 'abandoned' WHERE id = ? AND status = 'in_progress'`)
      .run(goalId);
  }

  /** Abandon any leftover in_progress goal for this character — called before
   *  inserting a new day's plan so we don't accumulate orphaned active rows. */
  abandonAllActive(characterId: number): number {
    const info = this.db
      .prepare(
        `UPDATE daily_goal SET status = 'abandoned'
         WHERE character_id = ? AND status = 'in_progress'`,
      )
      .run(characterId);
    return info.changes;
  }
}

function rowToGoal(row: DailyGoalRow): DailyGoal {
  return {
    id: row.id,
    day: row.day,
    summary: row.summary,
    reason: row.reason,
    alignment: row.alignment as Alignment,
    subGoals: parseSubGoals(row.sub_goals),
    currentStepIdx: row.current_step_idx,
    status: row.status as 'in_progress' | 'completed' | 'abandoned',
  };
}

function parseSubGoals(raw: string): SubGoal[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => {
      const sg: SubGoal = {
        text: typeof x.text === 'string' ? x.text : '',
        successCriteria: typeof x.successCriteria === 'string' ? x.successCriteria : '',
        completed: x.completed === true,
      };
      const check = parseStoredCheck(x.check);
      if (check) sg.check = check;
      return sg;
    });
  } catch {
    return [];
  }
}

// Validate a check object pulled from storage. Same shape constraints as the
// LLM parser but lenient — any stored shape that doesn't match a known variant
// is dropped, leaving the sub-goal to fall back to LLM self-tag.
function parseStoredCheck(raw: unknown): SubGoalCheck | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const type = r.type;
  if (type === 'action_performed' && typeof r.value === 'string') {
    return { type: 'action_performed', value: r.value };
  }
  if (type === 'inventory_has' && typeof r.item === 'string') {
    return { type: 'inventory_has', item: r.item };
  }
  if (type === 'chunk_visited_new') {
    return { type: 'chunk_visited_new' };
  }
  return undefined;
}

// Strip volatile fields and re-emit the stored shape we want on disk. Keeps
// `check` only when present so vague sub-goals don't end up with an explicit
// `"check":undefined` round-trip artefact.
function serializeSubGoal(sg: SubGoal): Record<string, unknown> {
  const out: Record<string, unknown> = {
    text: sg.text,
    successCriteria: sg.successCriteria,
    completed: sg.completed === true,
  };
  if (sg.check) out.check = sg.check;
  return out;
}
