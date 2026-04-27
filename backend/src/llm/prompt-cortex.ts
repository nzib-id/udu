// Cortex prompt — full LLM-driven decision making. Replaces the
// utility-AI-then-LLM-picks-from-narrow-list flow with a single LLM call that
// chooses from EVERY available action (feed + wander + maintenance + rest +
// stay). Utility AI stays in the codebase as fallback only.
//
// Design fidelity (continued from prompt-feed.ts pivot):
// - NO mechanic disclosure. We do not tell the LLM "raw meat causes
//   sickness", "fire warms you", "night cuts vision". Cause→effect is induced
//   from the observation log + cached lessons (spirit memory) only.
// - Stat scale definitions are perceptual ("hunger 0=starving, 100=full"),
//   not strategic ("eat below 60"). That is the line.
// - Survival principles are VALUE statements ("health is sacred"), not
//   tactical hints ("rest at fire at night").
// - "expected=+Nstat" tags on options stay — they are facts about the
//   immediate situation (cap behaviour) the LLM cannot derive from
//   observation alone.

import type { Character, DailyGoal } from '../../../shared/types.js';
import type { CortexOption } from '../ai.js';
import type { Observation, WorldStatus } from './choice-picker.js';
import { groupInventory, totalWeight } from '../../../shared/inventory.js';
import { MAX_INVENTORY_WEIGHT } from '../../../shared/config.js';
import { formatDailyGoalBlock } from './prompt-feed.js';
import { severity } from './severity.js';

const SYSTEM_BLOCK = `You are the cognition of a primitive survival character.

Stats (0-100). Keep these HIGH (raise via eat/drink/rest):
- hunger: 0=starving, 100=full
- thirst: 0=dehydrated, 100=hydrated
- energy: 0=collapsed, 100=fresh
- health: 0=DEATH, 100=alive (sacred — protect above all)

Keep these LOW (act when they rise):
- bladder: 0=empty, 100=urgent
- sickness: 0=healthy, 100=very sick

Other:
- temperature: body in °C (comfort near 22°C)

Survival principles (immutable values, not tactics):
- Health is sacred. Above all else, stay alive.
- Anticipate, do not just react. Acting before crisis is wiser than acting in crisis.
- The wisdom of past lives below — when present — is hard-won truth. Weigh it heavily.
- Survival pressure outranks any other goal. Goals can wait, life cannot.

You will be given:
- your current stats and inventory,
- nearby resources you remember (purely spatial — type, id, distance),
- recent observations: what your past actions did to your stats and inventory,
- lessons inherited from past lives (when any have been earned),
- a life goal and possibly a daily plan (when set),
- a single flat menu of every action you may take this turn.

Pick exactly one action. Some options carry an "expected=+Nstat[,+Mstat]" tag —
that is the actual stat change you would receive right now after the 0-100 cap
is applied. "expected=+0hunger" means the option would not raise hunger at all
(already full). A tag like "+20sickness" means the option also costs you that
stat.

You are not told the underlying mechanics — what each action does, when it is
risky, or what conditions matter. Your only sources of cause→effect are the
observation log and the lessons block. Use them.

If "Today's plan" is shown, the active sub-goal (marked >>>) is what you are
currently pursuing. Pick what advances it, but never override survival
pressure. If your chosen action satisfies the active sub-goal's
success_criteria, set "completes_subgoal" to true and "advances_subgoal_idx"
to the active index. Otherwise omit those fields or leave them null.

Write "reasoning" FIRST — one short sentence (max 15 words) that grounds your
decision in the current state (which stat is most pressing, what your last few
observations show). THEN commit to a choice. The "choice" field MUST equal one
of the kind=... values exactly. The "target" field, if present, MUST equal the
target=... id of that same option. Output STRICT JSON, reasoning first:
{"reasoning":"<one short sentence, max 15 words, grounded in current state>","choice":"<kind>","target":"<id_or_empty>","advances_subgoal_idx":<int_or_null>,"completes_subgoal":<bool_or_null>}`;

export function buildCortexPrompt(
  character: Character,
  options: CortexOption[],
  observations: Observation[],
  rules: string[],
  world: WorldStatus,
  rememberedSummary: string,
  phase: string,
  gameTimeStamp: string,
): string {
  const s = character.stats;
  const invLine = formatInventoryLine(character.inventory);
  const opts = options.map(formatOption).join('\n');
  const obs = observations.length > 0
    ? observations.map(formatObservation).join('\n')
    : '(none yet — no actions taken so far)';
  const lessonsBlock = rules.length === 0
    ? ''
    : `\nLessons from past lives (durable, hard-won truths):\n${rules.map((r) => `- ${r}`).join('\n')}\n`;
  const goalBlock = character.lifeGoal
    ? `\nLife goal: "${character.lifeGoal.text}" (priority ${character.lifeGoal.priority}/10) — ${character.lifeGoal.reason}\n`
    : '';
  const dailyBlock = formatDailyGoalBlock(character.dailyGoal ?? null);
  const fireLine = world.fireStatus ? `\n- ${world.fireStatus}` : '';

  return `/no_think
${SYSTEM_BLOCK}
${lessonsBlock}${goalBlock}${dailyBlock}
Current state:
- time: ${gameTimeStamp} (${phase})
- position=(${character.position.x.toFixed(1)},${character.position.y.toFixed(1)})
- hunger=${Math.round(s.hunger)} (${severity('hunger', s.hunger)}), thirst=${Math.round(s.thirst)} (${severity('thirst', s.thirst)}), energy=${Math.round(s.energy)} (${severity('energy', s.energy)}), bladder=${Math.round(s.bladder)} (${severity('bladder', s.bladder)}), sickness=${Math.round(s.sickness ?? 0)} (${severity('sickness', s.sickness ?? 0)}), health=${Math.round(s.health)} (${severity('health', s.health)}), temp=${Math.round(s.temperature)}°C (${severity('temperature', s.temperature)})
- ${invLine}${fireLine}
- nearby (remembered): ${rememberedSummary}

Recent observations (your own actions and their effects):
${obs}

Available actions:
${opts}

Output JSON only.`;
}

function formatInventoryLine(inv: readonly string[]): string {
  const w = totalWeight(inv).toFixed(1);
  if (inv.length === 0) return `inventory (0/${MAX_INVENTORY_WEIGHT}): empty`;
  const groups = groupInventory(inv).map((g) => `${g.count} ${g.item}`).join(', ');
  return `inventory (${w}/${MAX_INVENTORY_WEIGHT}): ${groups}`;
}

function formatOption(o: CortexOption): string {
  const parts: string[] = [`kind=${o.kind}`];
  if (o.target) parts.push(`target=${o.target}`);
  if (o.distance > 0) parts.push(`dist=${o.distance.toFixed(1)}t`);
  if (o.annotation) parts.push(o.annotation);
  return `- ${parts.join(' ')}`;
}

function formatObservation(o: Observation): string {
  const head = o.target ? `${o.action}(${o.target})` : o.action;
  const effects: string[] = [];
  if (o.dHunger !== undefined) effects.push(`hunger${signed(o.dHunger)}`);
  if (o.dThirst !== undefined) effects.push(`thirst${signed(o.dThirst)}`);
  if (o.dEnergy !== undefined) effects.push(`energy${signed(o.dEnergy)}`);
  if (o.dSickness !== undefined) effects.push(`sickness${signed(o.dSickness)}`);
  if (o.inv) effects.push(`inv ${o.inv}`);
  const tail = effects.length > 0
    ? effects.join(', ')
    : (o.failReason ?? 'no visible effect');
  return `- ${o.t} ${head} → ${tail}`;
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
