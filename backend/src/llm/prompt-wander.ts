// Build the LLM prompt for the wander/explore decision. Used when the
// character has no urgent need but is idle. The model picks a direction (or
// "stay") given annotated targets — unexplored zones, areas near remembered
// resources, map edges. The intent is to give exploration a personality:
// chase unmapped tiles when fresh, revisit known food when getting peckish,
// rest when tired.

import type { Character } from '../../../shared/types.js';
import type { Observation, WanderOption, WorldStatus } from './choice-picker.js';
import { formatDailyGoalBlock } from './prompt-feed.js';
import { TEMPERATURE_CONFIG } from '../../../shared/config.js';
import { severity } from './severity.js';

const SYSTEM_BLOCK = `You are the cognition of a primitive survival character deciding what to do next while idle.
No critical alarm is firing right now. You can either move (explore/revisit), rest in place, or pre-emptively eat/drink to keep your needs comfortable. Choose what serves you best given your current stats and surroundings.

Direction options ("wander_*", "stay") notes describe the destination:
- Composition tag: "nothing" (no remembered resource near target) OR a type list like "bushx3+tree" (3 berry bushes and 1 fruit tree remembered within 4 tiles).
- "age=Xh": game-hours since you last laid eyes on the freshest resource in that group. Higher = more stale memory.
- "unvisited": you have never set foot in this chunk of the map (strong curiosity signal).
- "visited=N": you have entered this chunk N times before.
- "edge": target is within 2 tiles of the map boundary.
- "at_pos": stay where you are (rest in place).

Verb options use generic kinds — the "target" field carries the specific
identity. Read each option's annotation for the precise effect:
- "eat" with target=<inventory item>: consume one piece from your inventory in-place. The annotation shows the item name and "expected=+Nhunger".
- "drink" with target=<river_id>: walk to the river and drink. "expected=+Nthirst" caps at 100.
- "pickup" with target=<item_or_id>: walk to a loose item on the ground and pick it up.
- "shake" with target=<source_id>: shake a source (bush, tree). The annotation describes distance and any tags.
- "drop" with target=<inventory item>: drop one piece to free weight.
- "defecate": walk to a clear spot and relieve yourself.
- "rest" near a fire: drift body temperature toward the fire's ambient.
- "sleep": only surfaces at night near a lit fire — sleep recovery is best then ("recovery=×1.8").

Body temperature: ${TEMPERATURE_CONFIG.comfortMin}–${TEMPERATURE_CONFIG.comfortMax}°C is safe. Below ${TEMPERATURE_CONFIG.comfortMin} or above ${TEMPERATURE_CONFIG.comfortMax} drains health directly. Sleeping inside a lit fire's warmth is fully safe from cold.

Heuristics:
- Prefer "unvisited" when stats are comfortable — that is how you discover new resources.
- Prefer rich composition with low age when stats are starting to dip.
- Avoid revisiting "nothing,visited=N" with high N — barren area.
- Eat pre-emptively when hunger is dipping (e.g. below 60) and you have food on hand. You can pick eat multiple decisions in a row to top up — your body keeps a running record of recent eats so you do not need to count them yourself, just check whether you still feel hungry.
- Drink pre-emptively when thirst is dipping below ~60 and a river is reachable.
- Stop eating/drinking once your stat feels comfortable (≥70 is full enough). Beyond that, return to exploring.

If "Today's plan" is shown, the active sub-goal (marked >>>) describes what
you should pursue right now — pick what advances it. If your chosen action
will satisfy the active sub-goal's success_criteria when it lands, set
"completes_subgoal" to true and "advances_subgoal_idx" to the active index.
Otherwise omit those fields or leave them null.

Pick one option from the list. Write "reasoning" FIRST — one short sentence (max 15 words) that grounds your decision in the current state. THEN commit to a choice. The "choice" field MUST equal one of the kind=... values exactly. Output STRICT JSON, reasoning first:
{"reasoning":"<one short sentence, max 15 words, grounded in current state>","choice":"<kind>","advances_subgoal_idx":<int_or_null>,"completes_subgoal":<bool_or_null>}`;

export function buildWanderPrompt(
  character: Character,
  options: WanderOption[],
  rememberedSummary: string,
  world: WorldStatus,
  observations: Observation[],
): string {
  const s = character.stats;
  const opts = options.map((o) => formatOption(o)).join('\n');
  const goalLine = character.lifeGoal
    ? `\nLife goal: "${character.lifeGoal.text}" (priority ${character.lifeGoal.priority}/10) — ${character.lifeGoal.reason}\nLet this goal break ties between equally-good options. Never override survival pressure for it.`
    : '';
  const dailyBlock = formatDailyGoalBlock(character.dailyGoal ?? null);
  const fireLine = world.fireStatus ? `\n- ${world.fireStatus}` : '';
  const tempNote = `°C (comfort ${TEMPERATURE_CONFIG.comfortMin}–${TEMPERATURE_CONFIG.comfortMax} — outside this band drains health)`;

  // Inventory + recent consume observations help the LLM decide whether to
  // top up. Recent obs scoped to last few entries — enough signal without
  // bloating prompt.
  const invSummary = summarizeInventory(character.inventory);
  const recentConsume = formatRecentConsume(observations);

  return `/no_think
${SYSTEM_BLOCK}
${goalLine}${dailyBlock}
Current state:
- position=(${character.position.x.toFixed(1)},${character.position.y.toFixed(1)})
- hunger=${Math.round(s.hunger)} (${severity('hunger', s.hunger)}), thirst=${Math.round(s.thirst)} (${severity('thirst', s.thirst)}), energy=${Math.round(s.energy)} (${severity('energy', s.energy)}), sickness=${Math.round(s.sickness ?? 0)} (${severity('sickness', s.sickness ?? 0)}), health=${Math.round(s.health)} (${severity('health', s.health)})
- temp=${Math.round(s.temperature)} (${severity('temperature', s.temperature)})${tempNote}${fireLine}
- inventory: ${invSummary}
- recent eats/drinks: ${recentConsume}
- remembered: ${rememberedSummary}

Available options:
${opts}

Output JSON only.`;
}

function summarizeInventory(inv: string[]): string {
  if (inv.length === 0) return 'empty';
  const counts: Record<string, number> = {};
  for (const item of inv) counts[item] = (counts[item] ?? 0) + 1;
  return Object.entries(counts)
    .map(([k, n]) => `${n}${k}`)
    .join(', ');
}

function formatRecentConsume(obs: Observation[]): string {
  // Show the last few eat/drink events so the LLM can see whether it has been
  // topping up recently. Keeps it short — 3 entries is enough.
  const recents = obs
    .filter((o) => o.action === 'eat' || o.action === 'drink')
    .slice(-3);
  if (recents.length === 0) return 'none';
  return recents
    .map((o) => {
      const dh = typeof o.dHunger === 'number' ? `+${o.dHunger}h` : '';
      const dt = typeof o.dThirst === 'number' ? `+${o.dThirst}t` : '';
      const tag = [dh, dt].filter(Boolean).join('');
      return `${o.t} ${o.action}${tag ? ` ${tag}` : ''}`;
    })
    .join('; ');
}

function formatOption(o: WanderOption): string {
  const parts: string[] = [`kind=${o.kind}`];
  if (o.distance > 0) parts.push(`dist=${o.distance.toFixed(0)}t`);
  parts.push(`note=${o.annotation}`);
  return `- ${parts.join(' ')}`;
}
