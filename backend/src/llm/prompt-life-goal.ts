// Build the LLM prompt for life-goal generation. Called once on spawn (after
// the world-summary is ready). The LLM must ground every goal in entities
// listed under "Allowed entities" — referenced_entities is validated by
// life-goal.ts; anything outside that set rejects the goal and triggers one
// retry, then a no-goal fallback so the character is never blocked on spawn.
//
// Self-rated priority (1-10) lets the model express "this is critical" vs
// "would be nice if I had nothing else to do". Used downstream by feed/wander
// prompts as a tiebreaker, not as an override against survival needs.

import type { Character } from '../../../shared/types.js';

const SYSTEM_BLOCK = `You are the cognition of a primitive survival character at the start of a new life. Pick ONE life goal — a long-horizon aspiration that gives this life direction.

Constraints:
- The goal MUST reference only entities listed under "Allowed entities" below. Do not invent monsters, NPCs, items, or places that are not in the list. If you say "find water", "water" must be an allowed entity (river, drink, etc.).
- The goal should be concrete enough to act on. "Be happy" is too vague. "Map every unexplored region" is concrete.
- The reason should explain WHY this goal — based on past deaths, current ignorance, lessons, or basic survival pressure.
- Priority is self-rated 1-10. 10 = "without this I will die soon"; 1 = "trivial curiosity, ignore if anything else comes up".

Output STRICT JSON, goal first:
{"goal":"<one short sentence>","reason":"<one short sentence>","priority":<int 1-10>,"referenced_entities":["<entity>","<entity>"]}`;

export function buildLifeGoalPrompt(character: Character, worldSummaryText: string, allowed: Set<string>): string {
  const s = character.stats;
  const allowedLine = Array.from(allowed).join(', ') || '(none — first life with no observations yet)';
  return `/no_think
${SYSTEM_BLOCK}

You are character iteration ${character.iteration}.
Current state:
- hunger=${Math.round(s.hunger)}, thirst=${Math.round(s.thirst)}, energy=${Math.round(s.energy)}, sickness=${Math.round(s.sickness ?? 0)}

World you know about:
${worldSummaryText}

Allowed entities (use these, exactly, in referenced_entities):
${allowedLine}

Output JSON only.`;
}
