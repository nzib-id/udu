// Build the LLM prompt for life-goal generation. Called once on spawn (after
// the world-summary is ready). The LLM must ground every goal in entities
// listed under "Allowed entities" — referenced_entities is validated by
// life-goal.ts; anything outside that set rejects the goal and triggers one
// retry, then a no-goal fallback so the character is never blocked on spawn.
//
// Diagnose+prescribe pattern: the prompt forces a 2-step thought — first
// diagnose the recurring failure pattern across past generations of this
// lineage (using the trajectory block, if present), then prescribe a goal
// that addresses that bottleneck instead of repeating it. Trajectory is
// omitted on the first life (no past deaths), in which case diagnosis still
// runs but grounds in current pressures rather than lineage pattern.
//
// Self-rated priority (1-10) lets the model express "this is critical" vs
// "would be nice if I had nothing else to do". Used downstream by feed/wander
// prompts as a tiebreaker, not as an override against survival needs.

import type { Character } from '../../../shared/types.js';

const SYSTEM_BLOCK = `You are the cognition of a primitive survival character at the start of a new life. Pick ONE life goal — a long-horizon aspiration that gives this life direction.

Think in two steps:

## Step 1 — Diagnose
Look at the lineage trajectory and lessons. What is the recurring problem your ancestors faced? Did they keep dying of the same cause? Did they pursue the same kind of goal and never reach it? Did they fail to build the foundations they needed before chasing bigger ambitions? State the diagnosis in one short sentence.

## Step 2 — Prescribe
Given that diagnosis, pick a life goal that addresses the bottleneck. If past 2+ generations died pursuing similar goals, your goal MUST address a different bottleneck (survival, knowledge, tools, location) — not just rephrase the same aspiration. If this is the first life with no trajectory, diagnose against current pressures and pick a goal that fits this life's starting state.

Constraints:
- The goal MUST reference only entities listed under "Allowed entities" below. Do not invent monsters, NPCs, items, or places that are not in the list.
- The goal should be concrete enough to act on. "Be happy" is too vague. "Master finding water before traveling far" is concrete.
- The reason should explain WHY this goal — tie it back to the diagnosis.
- Priority is self-rated 1-10. 10 = "without this I will die soon"; 1 = "trivial curiosity, ignore if anything else comes up".

Output STRICT JSON, diagnosis first:
{"diagnosis":"<one short sentence>","goal":"<one short sentence>","reason":"<one short sentence>","priority":<int 1-10>,"referenced_entities":["<entity>","<entity>"]}`;

export function buildLifeGoalPrompt(
  character: Character,
  worldSummaryText: string,
  allowed: Set<string>,
  lineageTrajectoryText: string,
): string {
  const s = character.stats;
  const allowedLine = Array.from(allowed).join(', ') || '(none — first life with no observations yet)';
  const trajectoryBlock = lineageTrajectoryText
    ? `\n${lineageTrajectoryText}\n`
    : '\n(This is the first life in this lineage — no trajectory yet.)\n';
  return `/no_think
${SYSTEM_BLOCK}

You are character iteration ${character.iteration}.
Current state:
- hunger=${Math.round(s.hunger)}, thirst=${Math.round(s.thirst)}, energy=${Math.round(s.energy)}, sickness=${Math.round(s.sickness ?? 0)}
${trajectoryBlock}
World you know about:
${worldSummaryText}

Allowed entities (use these, exactly, in referenced_entities):
${allowedLine}

Output JSON only.`;
}
