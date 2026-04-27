// Generate a daily plan for the live character. Calls Ollama with a fresh
// world-summary, validates that every referenced_entity is in the allowed set
// and that 2-4 well-formed sub-goals were emitted. One retry on rejection,
// then null fallback so the day is never blocked by a bad LLM output.
//
// Mirrors life-goal.ts shape (same world-summary + allowed-entities pattern)
// but emits a multi-step plan and an alignment tag. Not coupled to lineage —
// scoped to the live character (wiped on death along with its goals).

import type {
  Alignment,
  ActionType,
  Character,
  DailyGoal,
  LifeGoal,
  SubGoal,
  SubGoalCheck,
} from '../../../shared/types.js';
import { generate, type OllamaOptions } from './ollama-client.js';
import { buildDailyGoalPrompt } from './prompt-daily-goal.js';
import { buildWorldSummary } from './world-summary.js';
import type { RememberedResource } from '../spatial-memory-repo.js';
import type { ChunkVisit } from '../chunk-visit-repo.js';
import type { EventRepo } from '../event-repo.js';
import type { DailyGoalRepo } from '../daily-goal-repo.js';

// Daily goal call is bigger than feed (full plan + reasoning) — give it room.
const DAILY_GOAL_TIMEOUT_MS = 120_000;

export type GenerateDailyGoalArgs = {
  character: Character;
  lifeGoal: LifeGoal | null;
  knownResources: RememberedResource[];
  chunkVisits: ChunkVisit[];
  eventRepo: EventRepo;
  cachedRules: string[];
  yesterdayGoal: DailyGoal | null;
  ollama: OllamaOptions;
  gameDay: number;
  repo: DailyGoalRepo;
  onLog?: (line: string) => void;
};

export async function generateDailyGoal(args: GenerateDailyGoalArgs): Promise<DailyGoal | null> {
  const log = args.onLog ?? (() => {});
  const summary = buildWorldSummary(
    args.character,
    args.knownResources,
    args.chunkVisits,
    args.eventRepo,
    args.cachedRules,
  );
  const yesterdayLine = formatYesterdaySummary(args.yesterdayGoal);
  const prompt = buildDailyGoalPrompt(
    args.character,
    args.lifeGoal,
    summary.text,
    summary.allowedEntities,
    yesterdayLine,
  );
  const ollama = { ...args.ollama, timeoutMs: DAILY_GOAL_TIMEOUT_MS };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await generate(ollama, prompt, { numPredict: 1600, temperature: 0.5 });
    if (!res.ok) {
      log(`[llm] daily-goal call failed (${res.kind}: ${res.error}) attempt=${attempt}`);
      continue;
    }
    const parsed = parse(res.text);
    if (!parsed) {
      log(`[llm] daily-goal unparseable (attempt=${attempt}): ${res.text.slice(0, 200)}`);
      continue;
    }
    const invalid = parsed.referenced_entities.filter((e) => !summary.allowedEntities.has(e));
    if (invalid.length > 0) {
      log(`[llm] daily-goal rejected — hallucinated entities ${JSON.stringify(invalid)} (attempt=${attempt})`);
      continue;
    }
    args.repo.abandonAllActive(args.character.id);
    const goal = args.repo.create({
      characterId: args.character.id,
      day: args.gameDay,
      summary: parsed.summary,
      reason: parsed.reason,
      alignment: parsed.alignment,
      subGoals: parsed.subGoals,
    });
    log(
      `[llm] daily-goal pick D${args.gameDay} alignment=${goal.alignment} steps=${goal.subGoals.length} (${res.totalDurationMs}ms) — ${goal.summary}`,
    );
    for (let i = 0; i < goal.subGoals.length; i++) {
      log(`[llm]   ${i + 1}. ${goal.subGoals[i].text} → ${goal.subGoals[i].successCriteria}`);
    }
    return goal;
  }
  return null;
}

function formatYesterdaySummary(g: DailyGoal | null): string | null {
  if (!g) return null;
  const status = g.status === 'completed'
    ? 'finished'
    : g.status === 'abandoned'
      ? `abandoned at step ${g.currentStepIdx + 1}/${g.subGoals.length}`
      : `still in progress (${g.currentStepIdx}/${g.subGoals.length})`;
  return `"${g.summary}" — ${status}.`;
}

type ParsedSubGoal = { text: string; success_criteria: string };
type Parsed = {
  summary: string;
  reason: string;
  alignment: Alignment;
  subGoals: SubGoal[];
  referenced_entities: string[];
};

function parse(text: string): Parsed | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    const alignmentRaw = typeof obj.alignment === 'string' ? obj.alignment.trim() : '';
    if (!summary || !reason) return null;
    if (alignmentRaw !== 'advances' && alignmentRaw !== 'maintains' && alignmentRaw !== 'survival_override') {
      return null;
    }
    const subGoalsRaw = Array.isArray(obj.sub_goals) ? obj.sub_goals : null;
    if (!subGoalsRaw) return null;
    const subGoals: SubGoal[] = [];
    for (const item of subGoalsRaw) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const t = typeof r.text === 'string' ? r.text.trim() : '';
      const sc = typeof r.success_criteria === 'string' ? r.success_criteria.trim() : '';
      if (!t || !sc) continue;
      const check = parseCheck(r.check);
      const sg: SubGoal = { text: t, successCriteria: sc, completed: false };
      if (check) sg.check = check;
      subGoals.push(sg);
    }
    if (subGoals.length < 2 || subGoals.length > 4) return null;
    const refs = Array.isArray(obj.referenced_entities)
      ? obj.referenced_entities.filter((x): x is string => typeof x === 'string')
      : [];
    return {
      summary,
      reason,
      alignment: alignmentRaw as Alignment,
      subGoals,
      referenced_entities: refs,
    };
  } catch {
    return null;
  }
}

// Silences unused-type warning when parser pre-validates shape; keeps ParsedSubGoal
// available for callers that want to read the raw shape. Module-internal only.
export type { ParsedSubGoal };

const ACTION_VALUES: ReadonlySet<ActionType> = new Set<ActionType>([
  'drink',
  'sleep',
  'defecate',
  'shake',
  'pickup',
  'eat',
  'hunt',
  'cook',
  'rest',
  'add_fuel',
  'drop',
]);

const INVENTORY_ITEMS = new Set([
  'berry', 'fruit', 'wood', 'branch', 'vine', 'stone', 'meat_raw', 'meat_cooked',
]);

// Validate the `check` field on a sub-goal. Permissive — drops the field when
// the shape is wrong rather than rejecting the whole goal, so the LLM can
// recover by falling back to self-tag for that step.
function parseCheck(raw: unknown): SubGoalCheck | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const type = typeof r.type === 'string' ? r.type : '';
  if (type === 'action_performed') {
    const value = typeof r.value === 'string' ? r.value : '';
    if (!ACTION_VALUES.has(value as ActionType)) return undefined;
    return { type: 'action_performed', value };
  }
  if (type === 'inventory_has') {
    const item = typeof r.item === 'string' ? r.item : '';
    if (!INVENTORY_ITEMS.has(item)) return undefined;
    return { type: 'inventory_has', item };
  }
  if (type === 'chunk_visited_new') {
    return { type: 'chunk_visited_new' };
  }
  return undefined;
}
