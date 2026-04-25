// Build the LLM prompt for daily-goal generation. Called once per game-day
// (post-reflection). Output is a multi-step plan grounded in the world summary
// the character actually knows. Every entity referenced in any sub-goal MUST
// appear in the allowed-set — daily-goal.ts validates and rejects on
// hallucination, then retries once before falling back to no-plan.
//
// alignment is a self-tag relating today's plan to the life goal:
//  - 'advances'           → plan pushes life-goal forward (explore, hunt, build)
//  - 'maintains'          → plan recovers/preps so tomorrow can advance
//  - 'survival_override'  → stats critical, life goal paused for the day
// Tracked per row in `daily_goal` so the reflection cycle can detect "char in
// survival_override 3 days running → re-evaluate life goal".

import type { Character, LifeGoal } from '../../../shared/types.js';

const SYSTEM_BLOCK = `You are the cognition of a primitive survival character planning today. Break the day into 2 to 4 sequential sub-goals — concrete, ordered tasks the character will pursue one at a time.

Constraints:
- Each sub-goal MUST be concrete (verb + object). "Find a new water source" is concrete. "Be productive" is not.
- Sub-goals MUST be sequential: complete #1 before starting #2.
- "referenced_entities" must contain ONLY names that appear verbatim in "Allowed entities" below. Stats (hunger, thirst, energy, sickness) and inventory item types (berry, fruit, wood, meat_raw, meat_cooked) are NOT entities — do not list them.
- success_criteria for each sub-goal should describe an observable end-state in one short clause ("inventory has fruit", "drink action performed", "visited a new chunk").
- Each sub-goal MAY include a structured "check" field — set it ONLY when the goal maps cleanly to ONE of these three shapes. The server auto-completes the step the moment the signal fires, so use the right shape:
  - {"type":"action_performed","value":"<action_kind>"}: the step finishes when this exact action fires once. Allowed values: drink, sleep, defecate, shake_tree, pickup_berry, pickup_fruit_ground, pickup_wood, eat_berry, eat_fruit, hunt, eat_meat, cook_meat, rest. Do NOT use 'wander' or 'walk_to' — those run constantly.
  - {"type":"inventory_has","item":"<item>"}: the step finishes the first tick the character holds this item. Allowed items: berry, fruit, wood, meat_raw, meat_cooked.
  - {"type":"chunk_visited_new"}: the step finishes when the character walks into a chunk they have never visited before.
  - Omit "check" entirely for goals that don't fit (e.g. "rest until energy >= 80", "build a stash") — the LLM choice picker will self-tag completion in those cases.
- alignment values:
  - "advances": today's plan pushes the life goal forward.
  - "maintains": stats need recovery / prep before pursuing the life goal — eat, drink, rest, gather wood/fruit/berry into inventory. There is no water container; drinking is instantaneous and does not stockpile.
  - "survival_override": one or more stats are critical and the life goal is paused for the day.

Output STRICT JSON, summary first:
{"summary":"<one short sentence overview of today>","reason":"<one short sentence WHY this plan>","alignment":"advances|maintains|survival_override","sub_goals":[{"text":"<one short imperative>","success_criteria":"<one short observable end-state>","check":<optional check object or omitted>}],"referenced_entities":["<entity>","<entity>"]}`;

export function buildDailyGoalPrompt(
  character: Character,
  lifeGoal: LifeGoal | null,
  worldSummaryText: string,
  allowed: Set<string>,
  yesterdaySummary: string | null,
): string {
  const s = character.stats;
  const allowedLine = Array.from(allowed).join(', ') || '(none — first life with no observations yet)';
  const lifeGoalLine = lifeGoal
    ? `Life goal: "${lifeGoal.text}" (priority ${lifeGoal.priority}/10) — ${lifeGoal.reason}`
    : 'Life goal: (none yet — generate a plan that gives this life direction anyway)';
  const yesterdayLine = yesterdaySummary
    ? `\nYesterday's plan: ${yesterdaySummary}`
    : '';
  return `/no_think
${SYSTEM_BLOCK}

${lifeGoalLine}${yesterdayLine}

Current state:
- hunger=${Math.round(s.hunger)}, thirst=${Math.round(s.thirst)}, energy=${Math.round(s.energy)}, sickness=${Math.round(s.sickness ?? 0)}

World you know about:
${worldSummaryText}

Allowed entities (use these, exactly, in referenced_entities):
${allowedLine}

Output JSON only.`;
}
