// Build the LLM prompt for the feed-choice decision.
//
// DESIGN PIVOT (2026-04-25): earlier version spoon-fed the model the mechanics
// ("cooked meat = +15 hunger, shake drops fruit, pick it up after, …").
// That worked but defeats Phase 4 — the agent should INDUCE cause→effect from
// its own history, not read the answer key. So this version strips all
// mechanic copy. The model gets:
//   - stat ranges (perceptual definitions, not mechanic rules)
//   - option list with kind / target / distance only
//   - recent-observations log: "you did X at time T → hunger +Y, inv +Z"
// The model has to read its own log to figure out what shake actually
// does. First lives will be dumb; once the reflection layer lands, learned
// rules persist as spirit-memory across deaths.
//
// English copy: see dev-log 2026-04-25 — token efficiency + JSON adherence.
// `/no_think` skips qwen3 reasoning phase. `choice` field first in JSON keeps
// the language of `reasoning` from drifting through autoregressive decode.

import type { Character, DailyGoal } from '../../../shared/types.js';
import type { FeedOption, Observation, WorldStatus } from './choice-picker.js';
import { groupInventory, totalWeight } from '../../../shared/inventory.js';
import { INVENTORY_WEIGHTS, MAX_INVENTORY_WEIGHT, TEMPERATURE_CONFIG, maskTarget } from '../../../shared/config.js';
import { severity } from './severity.js';

// Hard-coded short labels for the system block (model never sees the full
// INVENTORY_WEIGHTS Record so just inline the numbers it needs).
const INV_WEIGHT_HINT = {
  wood: INVENTORY_WEIGHTS['wood'] ?? 0,
  meat_raw: INVENTORY_WEIGHTS['meat_raw'] ?? 0,
  meat_cooked: INVENTORY_WEIGHTS['meat_cooked'] ?? 0,
  fruit: INVENTORY_WEIGHTS['fruit'] ?? 0,
  berry: INVENTORY_WEIGHTS['berry'] ?? 0,
};

const SYSTEM_BLOCK = `You are the cognition of a primitive survival character.

Stats (0-100). Keep these HIGH (raise via eat/drink/rest):
- hunger: 0=starving, 100=full
- thirst: 0=dehydrated, 100=hydrated
- energy: 0=collapsed, 100=fresh
- health: 0=DEATH, 100=alive (sacred — protect above all)

Keep these LOW (act when they rise):
- bladder: 0=empty, 100=urgent
- sickness: 0=healthy, 100=very sick

Keep this in the comfort band (drift outside drains health directly):
- temperature: body in °C. ${TEMPERATURE_CONFIG.comfortMin}–${TEMPERATURE_CONFIG.comfortMax}°C is safe. Below ${TEMPERATURE_CONFIG.comfortMin} or above ${TEMPERATURE_CONFIG.comfortMax} hurts you. Sleeping inside a lit fire's warmth is fully safe from cold.

Inventory has a total weight cap of ${MAX_INVENTORY_WEIGHT}. Items have weights:
wood ${INV_WEIGHT_HINT.wood}, meat_raw ${INV_WEIGHT_HINT.meat_raw}, meat_cooked ${INV_WEIGHT_HINT.meat_cooked}, fruit ${INV_WEIGHT_HINT.fruit}, berry ${INV_WEIGHT_HINT.berry}.
When inventory is full, pickup options for that item disappear from your option list — you have to consume or use something to free weight first.

You will be given a list of available options and a log of your recent
actions and what they did to your stats and inventory. Use that log to figure
out which option will actually help. Do not assume any mechanic that is not
visible in the log — your own past observations are the only ground truth.

Some options carry an "expected=+Nstat[,+Mstat]" tag — that is the actual
stat change you would receive right now, after the 0-100 cap is applied.
"expected=+0hunger" means the option would not raise your hunger at all
because you are already full. A tag like "+20sickness" means the option
also costs you that stat.

If "Today's plan" is shown, the active sub-goal (marked >>>) is what you are
currently pursuing. Pick the option that best advances it, but never override
survival pressure. If your chosen action satisfies the active sub-goal's
success_criteria, set "completes_subgoal" to true and "advances_subgoal_idx"
to the active index — that flips the plan to the next sub-goal. Otherwise
omit those fields or leave them null.

Pick one option from the provided list. Write "reasoning" FIRST — one short
sentence (max 15 words) that grounds your decision in the current state (which
stat is most pressing, what your recent observations show). THEN commit to a
choice. The "choice" field MUST equal one of the kind=... values exactly. The
"target" field, if present, MUST equal the target=... id of that same option.
Output STRICT JSON, reasoning first:
{"reasoning":"<one short sentence, max 15 words, grounded in current state>","choice":"<kind>","target":"<id_or_empty>","advances_subgoal_idx":<int_or_null>,"completes_subgoal":<bool_or_null>}`;

export function buildFeedPrompt(
  character: Character,
  options: FeedOption[],
  observations: Observation[],
  rules: string[],
  world: WorldStatus,
): string {
  const s = character.stats;
  const invLine = formatInventoryLine(character.inventory);

  const opts = options.map((o) => formatOption(o)).join('\n');
  const obs = observations.length > 0
    ? observations.map((o) => formatObservation(o, character.glossary)).join('\n')
    : '(none yet — no actions taken so far)';
  const lessonsBlock = rules.length === 0
    ? ''
    : `\nLessons from past lives (treat these as durable, hard-won truths):\n${rules.map((r) => `- ${r}`).join('\n')}\n`;
  const goalBlock = character.lifeGoal
    ? `\nLife goal: "${character.lifeGoal.text}" (priority ${character.lifeGoal.priority}/10). Survival comes first; let this goal break ties between equally-good options.\n`
    : '';
  const dailyBlock = formatDailyGoalBlock(character.dailyGoal ?? null);

  const fireLine = world.fireStatus ? `\n- ${world.fireStatus}` : '';
  return `/no_think
${SYSTEM_BLOCK}
${lessonsBlock}${goalBlock}${dailyBlock}
Current state:
- hunger=${Math.round(s.hunger)} (${severity('hunger', s.hunger)}), thirst=${Math.round(s.thirst)} (${severity('thirst', s.thirst)}), energy=${Math.round(s.energy)} (${severity('energy', s.energy)}), sickness=${Math.round(s.sickness ?? 0)} (${severity('sickness', s.sickness ?? 0)}), health=${Math.round(s.health)} (${severity('health', s.health)}), temp=${Math.round(s.temperature)}°C (${severity('temperature', s.temperature)})
- ${invLine}${fireLine}

Recent observations (your own actions and their effects):
${obs}

Available options:
${opts}

Output JSON only.`;
}

// Render inventory as `inventory (4.5/10): 2 wood, 3 berry` so the LLM sees
// both individual items and overall weight pressure.
function formatInventoryLine(inv: readonly string[]): string {
  const w = totalWeight(inv).toFixed(1);
  if (inv.length === 0) return `inventory (0/${MAX_INVENTORY_WEIGHT}): empty`;
  const groups = groupInventory(inv).map((g) => `${g.count} ${g.item}`).join(', ');
  return `inventory (${w}/${MAX_INVENTORY_WEIGHT}): ${groups}`;
}

function formatOption(o: FeedOption): string {
  const parts: string[] = [`kind=${o.kind}`];
  if (o.target) parts.push(`target=${o.target}`);
  if (o.distance > 0) parts.push(`dist=${o.distance.toFixed(1)} tiles`);
  if (o.annotation) parts.push(o.annotation);
  return `- ${parts.join(' ')}`;
}

function formatObservation(o: Observation, glossary: Character['glossary']): string {
  const maskedTarget = o.target ? maskTarget(o.target, glossary) : undefined;
  const head = maskedTarget ? `${o.action}(${maskedTarget})` : o.action;
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

// Render the active daily plan into a prompt block. Lists sub-goals in order;
// the active step (current_step_idx) is prefixed with ">>>" so the model knows
// which one to advance. Skipped entirely when no plan is active or when the
// plan has already finished — char free-roams with only life goal injected.
export function formatDailyGoalBlock(goal: DailyGoal | null): string {
  if (!goal) return '';
  if (goal.status !== 'in_progress') return '';
  const steps = goal.subGoals
    .map((sg, i) => {
      const marker = i === goal.currentStepIdx ? '>>> ' : i < goal.currentStepIdx ? '✓   ' : '    ';
      return `${marker}${i + 1}. ${sg.text} [success: ${sg.successCriteria}]`;
    })
    .join('\n');
  return `\nToday's plan (alignment=${goal.alignment}): ${goal.summary}\n${steps}\n`;
}
