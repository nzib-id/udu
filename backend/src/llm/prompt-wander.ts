// Build the LLM prompt for the wander/explore decision. Used when the
// character has no urgent need but is idle. The model picks a direction (or
// "stay") given annotated targets — unexplored zones, areas near remembered
// resources, map edges. The intent is to give exploration a personality:
// chase unmapped tiles when fresh, revisit known food when getting peckish,
// rest when tired.

import type { Character } from '../../../shared/types.js';
import type { WanderOption } from './choice-picker.js';
import { formatDailyGoalBlock } from './prompt-feed.js';

const SYSTEM_BLOCK = `You are the cognition of a primitive survival character deciding where to go next while idle.
You have no urgent need right now. Balance two drives: curiosity (visit areas you have never been to) and memory (revisit places where you saw useful resources). Rest in place if you are tired.

Each option's note is a comma-separated tag list describing the destination:
- Composition tag: "nothing" (no remembered resource near target) OR a type list like "bushx3+tree" (3 berry bushes and 1 fruit tree remembered within 4 tiles).
- "age=Xh": game-hours since you last laid eyes on the freshest resource in that group. Higher = more stale memory (resources may have regrown or been depleted).
- "unvisited": you have never set foot in this chunk of the map (strong curiosity signal).
- "visited=N": you have entered this chunk N times before (revisit, not new).
- "edge": target is within 2 tiles of the map boundary.
- "at_pos": stay where you are (rest in place).

Heuristics:
- Prefer "unvisited" when stats are healthy — that is how you discover new resources.
- Prefer rich composition with low age (fresh memory) when stats are starting to dip.
- Avoid revisiting "nothing,visited=N" with high N — barren area.

If "Today's plan" is shown, the active sub-goal (marked >>>) describes what
you should pursue right now — pick a direction that advances it. If your
chosen direction will satisfy the active sub-goal's success_criteria when you
get there, set "completes_subgoal" to true and "advances_subgoal_idx" to the
active index. Otherwise omit those fields or leave them null.

Pick one option from the list. The "choice" field MUST equal one of the kind=... values exactly. Output STRICT JSON, choice first:
{"choice":"<kind>","reasoning":"<one short English sentence>","advances_subgoal_idx":<int_or_null>,"completes_subgoal":<bool_or_null>}`;

export function buildWanderPrompt(
  character: Character,
  options: WanderOption[],
  rememberedSummary: string,
): string {
  const s = character.stats;
  const opts = options.map((o) => formatOption(o)).join('\n');
  const goalLine = character.lifeGoal
    ? `\nLife goal: "${character.lifeGoal.text}" (priority ${character.lifeGoal.priority}/10) — ${character.lifeGoal.reason}\nLet this goal break ties between equally-good options. Never override survival pressure for it.`
    : '';
  const dailyBlock = formatDailyGoalBlock(character.dailyGoal ?? null);

  return `/no_think
${SYSTEM_BLOCK}
${goalLine}${dailyBlock}
Current state:
- position=(${character.position.x.toFixed(1)},${character.position.y.toFixed(1)})
- hunger=${Math.round(s.hunger)}, thirst=${Math.round(s.thirst)}, energy=${Math.round(s.energy)}, sickness=${Math.round(s.sickness ?? 0)}
- remembered: ${rememberedSummary}

Available options:
${opts}

Output JSON only.`;
}

function formatOption(o: WanderOption): string {
  const parts: string[] = [`kind=${o.kind}`];
  if (o.distance > 0) parts.push(`dist=${o.distance.toFixed(0)}t`);
  parts.push(`note=${o.annotation}`);
  return `- ${parts.join(' ')}`;
}
