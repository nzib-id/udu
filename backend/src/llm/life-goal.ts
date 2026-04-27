// Generate a life goal for a freshly-spawned character. Calls the LLM with a
// world summary of what this character knows, validates that every
// referenced_entity is in the allowed set (no hallucination), retries once on
// rejection, then falls back to no-goal so the spawn flow is never blocked.

import type { Character, LifeGoal } from '../../../shared/types.js';
import { generate, type OllamaOptions } from './ollama-client.js';
import { buildLifeGoalPrompt } from './prompt-life-goal.js';
import { buildWorldSummary, buildLineageTrajectoryText } from './world-summary.js';
import type { RememberedResource } from '../spatial-memory-repo.js';
import type { ChunkVisit } from '../chunk-visit-repo.js';
import type { EventRepo } from '../event-repo.js';
import type { CharacterRepo } from '../character-repo.js';

const LINEAGE_TRAJECTORY_LIMIT = 5;
// Life-goal call needs more time than the default 8s: diagnose+prescribe pattern
// + 280 numPredict ≈ 10-15s warm. Daily-goal observed at 6.5s on similar load,
// life-goal will sit just over the default. 20s gives headroom incl cold start.
const LIFE_GOAL_TIMEOUT_MS = 20000;

export type GenerateLifeGoalArgs = {
  character: Character;
  knownResources: RememberedResource[];
  chunkVisits: ChunkVisit[];
  eventRepo: EventRepo;
  characterRepo: CharacterRepo;
  lineageId: number;
  cachedRules: string[];
  ollama: OllamaOptions;
  gameDay: number;
  onLog?: (line: string) => void;
};

export async function generateLifeGoal(args: GenerateLifeGoalArgs): Promise<LifeGoal | null> {
  const log = args.onLog ?? (() => {});
  const summary = buildWorldSummary(
    args.character,
    args.knownResources,
    args.chunkVisits,
    args.eventRepo,
    args.cachedRules,
  );
  const trajectoryText = buildLineageTrajectoryText(
    args.characterRepo,
    args.lineageId,
    LINEAGE_TRAJECTORY_LIMIT,
  );
  const prompt = buildLifeGoalPrompt(args.character, summary.text, summary.allowedEntities, trajectoryText);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await generate(
      { ...args.ollama, timeoutMs: LIFE_GOAL_TIMEOUT_MS },
      prompt,
      { numPredict: 280, temperature: 0.8 },
    );
    if (!res.ok) {
      log(`[llm] life-goal call failed (${res.kind}: ${res.error}) attempt=${attempt}`);
      continue;
    }
    const parsed = parse(res.text);
    if (!parsed) {
      log(`[llm] life-goal unparseable (attempt=${attempt}): ${res.text.slice(0, 160)}`);
      continue;
    }
    const invalid = parsed.referenced_entities.filter((e) => !summary.allowedEntities.has(e));
    if (invalid.length > 0) {
      log(`[llm] life-goal rejected — hallucinated entities ${JSON.stringify(invalid)} (attempt=${attempt})`);
      continue;
    }
    log(
      `[llm] life-goal pick="${parsed.goal}" priority=${parsed.priority} diagnosis="${parsed.diagnosis}" (${res.totalDurationMs}ms)`,
    );
    return {
      text: parsed.goal,
      reason: parsed.reason,
      priority: parsed.priority,
      setAtDay: args.gameDay,
      diagnosis: parsed.diagnosis,
    };
  }
  return null;
}

type Parsed = {
  diagnosis: string;
  goal: string;
  reason: string;
  priority: number;
  referenced_entities: string[];
};

function parse(text: string): Parsed | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const diagnosis = typeof obj.diagnosis === 'string' ? obj.diagnosis.trim() : '';
    const goal = typeof obj.goal === 'string' ? obj.goal.trim() : '';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    const priority = typeof obj.priority === 'number' ? Math.round(obj.priority) : NaN;
    const refs = Array.isArray(obj.referenced_entities)
      ? obj.referenced_entities.filter((x): x is string => typeof x === 'string')
      : [];
    if (!diagnosis || !goal || !reason) return null;
    if (!Number.isFinite(priority) || priority < 1 || priority > 10) return null;
    return { diagnosis, goal, reason, priority, referenced_entities: refs };
  } catch {
    return null;
  }
}
