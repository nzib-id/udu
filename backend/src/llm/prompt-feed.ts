// Build the LLM prompt for the feed-choice decision.
//
// DESIGN PIVOT (2026-04-25): earlier version spoon-fed the model the mechanics
// ("cooked meat = +15 hunger, shake_tree drops fruit, pick it up after, …").
// That worked but defeats Phase 4 — the agent should INDUCE cause→effect from
// its own history, not read the answer key. So this version strips all
// mechanic copy. The model gets:
//   - stat ranges (perceptual definitions, not mechanic rules)
//   - option list with kind / target / distance only
//   - recent-observations log: "you did X at time T → hunger +Y, inv +Z"
// The model has to read its own log to figure out what shake_tree actually
// does. First lives will be dumb; once the reflection layer lands, learned
// rules persist as spirit-memory across deaths.
//
// English copy: see dev-log 2026-04-25 — token efficiency + JSON adherence.
// `/no_think` skips qwen3 reasoning phase. `choice` field first in JSON keeps
// the language of `reasoning` from drifting through autoregressive decode.

import type { Character, DailyGoal } from '../../../shared/types.js';
import type { FeedOption, Observation } from './choice-picker.js';

const SYSTEM_BLOCK = `You are the cognition of a primitive survival character.
Stats per character (range 0-100):
- hunger: 0=starving, 100=full. At 0, your health drops fast.
- thirst: 0=dehydrated, 100=hydrated. At 0, your health drops fastest of all.
- energy: 0=collapsed, 100=fresh. Restored by sleep/rest.
- sickness: 0=healthy, 100=very sick. Above 30 slows movement; at 80+ your health drops.
- health: your overall life force. 0 = death. Falls when needs hit 0; recovers slowly when all needs are well-met. Treat health as the truth that survives needs — manage needs to keep health up.

You will be given a list of available options and a log of your recent
actions and what they did to your stats and inventory. Use that log to figure
out which option will actually help. Do not assume any mechanic that is not
visible in the log — your own past observations are the only ground truth.

If "Today's plan" is shown, the active sub-goal (marked >>>) is what you are
currently pursuing. Pick the option that best advances it, but never override
survival pressure. If your chosen action satisfies the active sub-goal's
success_criteria, set "completes_subgoal" to true and "advances_subgoal_idx"
to the active index — that flips the plan to the next sub-goal. Otherwise
omit those fields or leave them null.

Pick one option from the provided list. The "choice" field MUST equal one of
the kind=... values exactly. The "target" field, if present, MUST equal the
target=... id of that same option. Output STRICT JSON, choice first:
{"choice":"<kind>","target":"<id_or_empty>","reasoning":"<one short English sentence>","advances_subgoal_idx":<int_or_null>,"completes_subgoal":<bool_or_null>}`;

export function buildFeedPrompt(
  character: Character,
  options: FeedOption[],
  observations: Observation[],
  rules: string[],
): string {
  const s = character.stats;
  const inv = character.inventory.length === 0
    ? 'empty'
    : character.inventory.join(', ');

  const opts = options.map((o) => formatOption(o)).join('\n');
  const obs = observations.length > 0
    ? observations.map((o) => formatObservation(o)).join('\n')
    : '(none yet — no actions taken so far)';
  const lessonsBlock = rules.length === 0
    ? ''
    : `\nLessons from past lives (treat these as durable, hard-won truths):\n${rules.map((r) => `- ${r}`).join('\n')}\n`;
  const goalBlock = character.lifeGoal
    ? `\nLife goal: "${character.lifeGoal.text}" (priority ${character.lifeGoal.priority}/10). Survival comes first; let this goal break ties between equally-good options.\n`
    : '';
  const dailyBlock = formatDailyGoalBlock(character.dailyGoal ?? null);

  return `/no_think
${SYSTEM_BLOCK}
${lessonsBlock}${goalBlock}${dailyBlock}
Current state:
- hunger=${Math.round(s.hunger)}, thirst=${Math.round(s.thirst)}, energy=${Math.round(s.energy)}, sickness=${Math.round(s.sickness ?? 0)}, health=${Math.round(s.health)}
- inventory: ${inv}

Recent observations (your own actions and their effects):
${obs}

Available options:
${opts}

Output JSON only.`;
}

function formatOption(o: FeedOption): string {
  const parts: string[] = [`kind=${o.kind}`];
  if (o.target) parts.push(`target=${o.target}`);
  if (o.distance > 0) parts.push(`dist=${o.distance.toFixed(1)} tiles`);
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
  const tail = effects.length > 0 ? effects.join(', ') : 'no visible effect';
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
